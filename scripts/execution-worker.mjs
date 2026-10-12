#!/usr/bin/env node
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { discoverAppServerAiCatalog } from '../server/ai-chat-catalog.mjs';
import { CodexAppServer } from '../server/codex-app-server.mjs';
import { buildCodexArgs, normalizeCodexEvent, spawnCodexTurn } from '../server/ai-chat-process.mjs';
import { resolveCodexExecutable } from '../shared/codex-executable.mjs';
import { signalProcessTree } from '../shared/process-tree.mjs';

function required(name) {
  const value = process.env[`CODEX_TASKBOARD_${name}`];
  if (!value) throw new Error(`CODEX_TASKBOARD_${name} is required`);
  return value;
}

async function main() {
  const server = new URL(required('SERVER_URL'));
  const loopback = server.hostname === 'localhost' || server.hostname === '[::1]'
    || /^127\.\d+\.\d+\.\d+$/.test(server.hostname);
  if ((server.protocol !== 'https:' && !(server.protocol === 'http:' && loopback))
    || server.username || server.password || server.search || server.hash) {
    throw new Error('Server URL must use HTTPS (HTTP is allowed only on loopback), without credentials, query or fragment');
  }
  server.pathname = server.pathname.replace(/\/$/, '') + '/';
  const token = required('SERVICE_TOKEN');
  const id = required('WORKER_ID');
  const name = process.env.CODEX_TASKBOARD_WORKER_NAME || id;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid worker ID');
  const configuredRoots = JSON.parse(required('WORKSPACE_ROOTS'));
  if (!Array.isArray(configuredRoots) || !configuredRoots.length
    || configuredRoots.some(root => typeof root !== 'string' || !path.isAbsolute(root))) {
    throw new Error('WORKSPACE_ROOTS must be a nonempty JSON array of absolute paths');
  }
  const workspaceRoots = [...new Set(configuredRoots.map(root => realpathSync(root)))];
  for (const root of workspaceRoots) {
    if (!statSync(root).isDirectory()) throw new Error('Workspace roots must be directories');
  }
  const dataDirectory = path.resolve(required('WORKER_DATA_DIR'));
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  // A separate SQLite write lock lives for this process, and is released by the OS on crash.
  // Receipts/outbox use their own database so their transactions can commit durably.
  const lock = new DatabaseSync(path.join(dataDirectory, 'worker-lock.sqlite'));
  let db;
  let identityVerified = false;
  let active = null;
  let stopping = false;
  let heartbeatTimer;
  let heartbeatPending = null;
  let flushing = null;
  const workerPath = `api/execution/workers/${encodeURIComponent(id)}`;
  const childEnv = { ...process.env };
  delete childEnv.CODEX_TASKBOARD_SERVICE_TOKEN;
  const executable = resolveCodexExecutable({ env: childEnv });
  const warn = error => console.error(`[execution-worker] ${String(error.message ?? error).replaceAll(token, '[redacted]')}`);

  function interrupt(reason) {
    if (!active || active.interrupted) return;
    active.interrupted = reason;
    if (active.child && active.child.exitCode === null && active.child.signalCode === null) {
      signalProcessTree(active.child, 'SIGKILL');
    }
  }
  function stop() {
    stopping = true;
    interrupt('Worker stopped');
  }
  async function post(route, body) {
    const response = await fetch(new URL(route, server), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Central service ${route}: HTTP ${response.status}`);
    return response.json();
  }
  function transaction(action) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = action(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function enqueue(runId, payload) {
    transaction(() => {
      const receipt = db.prepare('SELECT sequence, status FROM receipts WHERE run_id=?').get(runId);
      if (receipt.status !== 'running') throw new Error('Cannot append to a finished receipt');
      const sequence = receipt.sequence + 1;
      db.prepare('INSERT INTO outbox(run_id, sequence, payload) VALUES (?,?,?)')
        .run(runId, sequence, JSON.stringify({ ...payload, sequence }));
      db.prepare('UPDATE receipts SET sequence=?, status=? WHERE run_id=?')
        .run(sequence, payload.result?.status ?? 'running', runId);
    });
  }
  function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      for (;;) {
        const row = db.prepare('SELECT * FROM outbox ORDER BY ordinal LIMIT 1').get();
        if (!row) return;
        const reply = await post(`${workerPath}/runs/${encodeURIComponent(row.run_id)}/events`, JSON.parse(row.payload));
        if (reply.accepted !== true) throw new Error('Central service did not acknowledge event');
        db.prepare('DELETE FROM outbox WHERE ordinal=?').run(row.ordinal);
        if (reply.cancelRequested && active?.runId === row.run_id) interrupt('Cancellation requested');
      }
    })().finally(() => { flushing = null; });
    return flushing;
  }
  function heartbeat() {
    if (heartbeatPending) return heartbeatPending;
    heartbeatPending = post(`${workerPath}/heartbeat`, {}).then(reply => {
      if (active && reply.cancelRunIds?.includes(active.runId)) interrupt('Cancellation requested');
    }).catch(warn).finally(() => { heartbeatPending = null; });
    return heartbeatPending;
  }
  async function execute(job) {
    if (typeof job.runId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(job.runId)) {
      throw new Error('Invalid run ID from central service');
    }
    // This commit precedes validation and spawning. A repeated claim can never start it twice.
    const inserted = db.prepare("INSERT OR IGNORE INTO receipts(run_id,status,sequence) VALUES (?,'running',0)").run(job.runId);
    if (!inserted.changes) throw new Error(`Already received run ${job.runId}; refusing to execute again`);
    active = { runId: job.runId, child: null, interrupted: null };
    let result;
    let runDirectory;
    try {
      if (stopping || job.cancelRequested) interrupt(stopping ? 'Worker stopped' : 'Cancellation requested');
      if (active.interrupted) throw new Error(active.interrupted);
      const { thread, input } = job;
      const requestedCwd = thread?.origin?.workspacePath;
      if (typeof requestedCwd !== 'string' || !path.isAbsolute(requestedCwd)) throw new Error('Job workspace must be absolute');
      const cwd = realpathSync(requestedCwd);
      if (!statSync(cwd).isDirectory() || !workspaceRoots.some(root => {
        const relative = path.relative(root, cwd);
        return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
      })) throw new Error('Job workspace is outside the allowed canonical workspace roots');
      if (!input || typeof input.message !== 'string') throw new Error('Job message must be text');
      for (const key of ['attachmentPaths', 'imagePaths', 'skillIds', 'references']) {
        if (input[key] != null && (!Array.isArray(input[key]) || input[key].length)) {
          throw new Error(`Remote ${key} are unsupported by this worker; submit plain text`);
        }
      }
      if (!['read-only', 'workspace-write', 'danger-full-access'].includes(thread.sandbox)) throw new Error('Invalid sandbox');
      if (thread.codexThreadId != null && !/^[a-zA-Z0-9_-]{1,128}$/.test(thread.codexThreadId)) throw new Error('Invalid Codex session ID');
      if (thread.sandbox === 'danger-full-access' && input.dangerFullAccessConfirmed !== true) throw new Error('Full access requires confirmation');
      const attachments = input.attachments ?? [];
      if (!Array.isArray(attachments)) throw new Error('Attachments must be an array');
      const attachmentPaths = [];
      const imagePaths = [];
      if (attachments.length) {
        runDirectory = realpathSync(mkdtempSync(path.join(dataDirectory, `run-${job.runId}-`)));
        for (const [index, attachment] of attachments.entries()) {
          if (!attachment || typeof attachment.filename !== 'string'
            || !attachment.filename || /[\\/\x00-\x1f]/.test(attachment.filename)
            || attachment.filename === '.' || attachment.filename === '..'
            || typeof attachment.contentType !== 'string' || typeof attachment.dataBase64 !== 'string') {
            throw new Error('Invalid attachment filename, content type or base64 data');
          }
          const data = Buffer.from(attachment.dataBase64, 'base64');
          if (data.toString('base64') !== attachment.dataBase64) throw new Error('Invalid attachment base64 data');
          const attachmentPath = path.join(runDirectory, `attachment-${index + 1}-${attachment.filename}`);
          writeFileSync(attachmentPath, data, { flag: 'wx', mode: 0o600 });
          attachmentPaths.push(attachmentPath);
          if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(attachment.contentType)) imagePaths.push(attachmentPath);
        }
      }
      const prompt = [
        ...(job.issue ? [
          'Task context:',
          `Identifier: ${job.issue.identifier ?? ''}`,
          `Title: ${job.issue.title ?? ''}`,
          `Description:\n${job.issue.description ?? ''}`,
          '',
        ] : []),
        ...(attachmentPaths.length ? ['Turn attachment paths:', ...attachmentPaths.map(file => JSON.stringify(file)), ''] : []),
        'User request:', input.message,
      ].join('\n');
      let terminal = null;
      let terminalError = '';
      let sessionId = thread.codexThreadId;
      const spawned = spawnCodexTurn({
        executable, args: buildCodexArgs({ ...thread, origin: { ...thread.origin, workspacePath: cwd } }, runDirectory ? [runDirectory] : [], imagePaths),
        prompt, env: childEnv,
        onRawEvent(raw) {
          const event = normalizeCodexEvent(raw);
          if (!event) return;
          if (event.kind === 'thread.started') {
            if (!/^[a-zA-Z0-9_-]{1,128}$/.test(event.threadId)
              || (sessionId && sessionId !== event.threadId)) throw new Error('Unexpected Codex session ID');
            sessionId = event.threadId;
            enqueue(job.runId, { threadId: sessionId });
          } else {
            const { kind, ...normalized } = event;
            enqueue(job.runId, { event: normalized });
            if (raw.type === 'turn.failed') { terminal = 'failed'; terminalError = event.content; }
            if (raw.type === 'turn.completed' && terminal !== 'failed') terminal = 'completed';
          }
          void flush().catch(warn);
        },
      });
      active.child = spawned.child;
      const outcome = await spawned.completion;
      result = active.interrupted
        ? { status: 'interrupted', exitCode: outcome.exitCode, error: active.interrupted }
        : { status: outcome.exitCode === 0 && terminal === 'completed' ? 'completed' : 'failed',
          exitCode: outcome.exitCode,
          error: terminalError || (outcome.exitCode === 0 && terminal === 'completed' ? null : `Codex ended without a successful turn (${outcome.signal ?? outcome.exitCode})`) };
    } catch (error) {
      result = { status: active.interrupted ? 'interrupted' : 'failed', error: active.interrupted || error.message };
    }
    enqueue(job.runId, { result });
    active = null;
    if (runDirectory) {
      try { rmSync(runDirectory, { recursive: true, force: true }); } catch (error) { warn(error); }
    }
    await flush();
  }

  try {
    lock.exec('BEGIN EXCLUSIVE');
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    db = new DatabaseSync(path.join(dataDirectory, 'worker.sqlite'));
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), server TEXT NOT NULL, worker TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (run_id TEXT PRIMARY KEY, status TEXT NOT NULL, sequence INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (ordinal INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, sequence INTEGER NOT NULL, payload TEXT NOT NULL, UNIQUE(run_id,sequence));`);
    db.prepare('INSERT OR IGNORE INTO identity VALUES (1,?,?)').run(server.href, id);
    const identity = db.prepare('SELECT * FROM identity').get();
    if (identity.server !== server.href || identity.worker !== id) throw new Error('Worker data directory belongs to another server or worker');
    identityVerified = true;
    for (const receipt of db.prepare("SELECT run_id FROM receipts WHERE status='running'").all()) {
      enqueue(receipt.run_id, { result: { status: 'interrupted', error: 'Worker restarted after receiving this run; execution was not replayed' } });
    }
    let catalog;
    const appServer = new CodexAppServer({ executable, processEnv: childEnv });
    try {
      catalog = await discoverAppServerAiCatalog({ appServer, workspacePath: workspaceRoots[0] });
    } finally { await appServer.close(); }
    // Composer references are flattened by the server; no worker-side skill bindings.
    catalog = { ...catalog, skills: [], commands: [] };
    let registered = false;
    while (!stopping) {
      try {
        if (!registered) {
          await post('api/execution/workers/register', { id, name, workspaceRoots, catalog });
          registered = true;
          heartbeatTimer = setInterval(() => {
            void heartbeat();
            void flush().catch(warn);
          }, 5_000);
          console.log(`[execution-worker] Registered ${id}`);
        }
        await flush();
        if (stopping) break;
        const { job } = await post(`${workerPath}/claim`, {});
        if (job) await execute(job);
        else if (!stopping) await sleep(2_000);
      } catch (error) {
        warn(error);
        if (!stopping) await sleep(2_000);
      }
    }
  } finally {
    clearInterval(heartbeatTimer);
    if (heartbeatPending) await heartbeatPending;
    if (db) {
      if (identityVerified) {
        try { await flush(); } catch (error) { warn(error); }
      }
      db.close();
    }
    lock.close();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

main().catch(error => {
  const token = process.env.CODEX_TASKBOARD_SERVICE_TOKEN;
  console.error(`[execution-worker] ${token ? String(error.message).replaceAll(token, '[redacted]') : error.message}`);
  process.exitCode = 1;
});
