import { randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { ApiError } from '../shared/api-fields.mjs';

const fail = (status, code, message) => { throw new ApiError(status, code, message); };
const now = () => new Date().toISOString();
const idPattern = /^[a-zA-Z0-9_-]{1,128}$/;

export function authenticateCentral(request, token) {
  const authorization = request.headers.authorization ?? '';
  let supplied = (request.headers.cookie ?? '').split(';').map(value => value.trim()).find(value => value.startsWith('adam_dashboard_session='))?.slice('adam_dashboard_session='.length) ?? '';
  if (authorization.startsWith('Bearer ')) supplied = authorization.slice(7);
  if (authorization.startsWith('Basic ')) {
    const credentials = Buffer.from(authorization.slice(6), 'base64').toString();
    if (credentials.startsWith('adam-dashboard:')) supplied = credentials.slice(15);
  }
  if (!authorization && supplied) {
    try { supplied = decodeURIComponent(supplied); } catch { supplied = ''; }
  }
  const actual = Buffer.from(supplied);
  const expected = Buffer.from(token);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    fail(401, 'AUTH_REQUIRED', 'Sign in as adam-dashboard with the service token');
  }
  // Browsers carry Basic credentials automatically. Only same-origin writes are accepted.
  if (request.headers.origin) {
    let origin;
    try { origin = new URL(request.headers.origin); } catch { fail(403, 'INVALID_ORIGIN', 'Invalid origin'); }
    if (origin.host !== request.headers.host || !['http:', 'https:'].includes(origin.protocol)) {
      fail(403, 'INVALID_ORIGIN', 'Central service requires a same-origin request');
    }
  }
}

export class CentralExecutionService {
  constructor({ database }) {
    this.database = database;
    this.sql = database.database;
    this.listeners = new Map();
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS execution_workers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, roots TEXT NOT NULL,
        catalog TEXT NOT NULL, last_seen INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS execution_threads (
        thread_id TEXT PRIMARY KEY REFERENCES ai_chat_threads(id) ON DELETE CASCADE,
        worker_id TEXT NOT NULL REFERENCES execution_workers(id)
      );
      CREATE TABLE IF NOT EXISTS execution_tasks (
        task_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES ai_chat_threads(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS execution_jobs (
        run_id TEXT PRIMARY KEY REFERENCES ai_chat_runs(id) ON DELETE CASCADE,
        worker_id TEXT NOT NULL REFERENCES execution_workers(id),
        payload TEXT NOT NULL, state TEXT NOT NULL, sequence INTEGER NOT NULL DEFAULT 0,
        cancel_requested INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
    `);
    this.lastExecutionStates = new Map();
    this.statusTimer = setInterval(() => {
      for (const row of this.sql.prepare("SELECT run_id FROM execution_jobs WHERE state IN ('queued','running')").all()) {
        const run = this.getRun(row.run_id);
        const state = `${run.executionStatus}:${run.cancelRequested}`;
        if (this.lastExecutionStates.get(run.id) !== state) {
          this.lastExecutionStates.set(run.id, state);
          this.emit(run.threadId, { type:'ai.run', run });
        }
      }
    }, 5_000);
    this.statusTimer.unref();
    this.composerCatalog = {
      candidatesForSurface: async (response) => response,
      rebindPersistedReferences: async () => fail(409, 'REMOTE_COMPOSER_UNAVAILABLE', 'Use plain text for remote execution'),
    };
  }
  register(input) {
    if (!idPattern.test(input.id ?? '') || typeof input.name !== 'string' || input.name.length > 160
      || !Array.isArray(input.workspaceRoots) || !input.workspaceRoots.length
      || input.workspaceRoots.some(root => typeof root !== 'string' || !path.posix.isAbsolute(root))
      || !Array.isArray(input.catalog?.models) || !input.catalog.models.length) {
      fail(400, 'INVALID_WORKER', 'Worker id, name, absolute workspace roots and model catalog are required');
    }
    this.sql.prepare(`INSERT INTO execution_workers VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, roots=excluded.roots,
      catalog=excluded.catalog, last_seen=excluded.last_seen`).run(
      input.id, input.name, JSON.stringify(input.workspaceRoots), JSON.stringify(input.catalog), Date.now());
    return this.workers().find(worker => worker.id === input.id);
  }
  workers() {
    return this.sql.prepare('SELECT * FROM execution_workers ORDER BY id').all().map(row => ({
      id: row.id, name: row.name, workspaceRoots: JSON.parse(row.roots),
      online: Date.now() - row.last_seen < 30_000, lastSeenAt: new Date(row.last_seen).toISOString(),
    }));
  }
  worker(id) {
    const row = this.sql.prepare('SELECT * FROM execution_workers WHERE id=?').get(id);
    if (!row) fail(404, 'WORKER_NOT_FOUND', 'Execution worker is not registered');
    return row;
  }
  target(projectId, workerId, issueId) {
    const project = this.database.getProject(projectId);
    if (!project) fail(404, 'PROJECT_NOT_FOUND', 'Project does not exist');
    const issue = issueId ? this.database.getTask(issueId) : null;
    if (issueId && (!issue || issue.projectId !== project.id || issue.archivedAt)) {
      fail(404, 'AI_CHAT_ISSUE_NOT_FOUND', 'Task does not belong to this active project');
    }
    const workspacePath = issue?.developmentContext?.type === 'worktree'
      ? issue.developmentContext.path : project.workspacePath;
    if (!workspacePath) fail(409, 'WORKSPACE_REQUIRED', 'Set the project execution workspace first');
    const eligible = this.workers().filter(worker => worker.workspaceRoots.some(root =>
      workspacePath === root || workspacePath.startsWith(root.replace(/\/$/, '') + '/')));
    const selected = workerId ? eligible.find(worker => worker.id === workerId)
      : eligible.length === 1 ? eligible[0] : null;
    if (!selected) fail(409, 'WORKER_SELECTION_REQUIRED', 'Select a worker that owns this project workspace');
    return { project, issue, workspacePath, workerId: selected.id, catalog: JSON.parse(this.worker(selected.id).catalog) };
  }
  async getCatalog(projectId, _resolved, target) {
    return this.target(projectId, target?.workerId).catalog;
  }
  async getComposerCandidates() {
    return { contractVersion: 'composer.v1', revision: 'central-text-v1', candidates: [], sources: [], hasMore: false };
  }
  composerCatalogForThread() { return this.composerCatalog; }
  decorate(thread) {
    if (!thread) fail(404, 'AI_CHAT_THREAD_NOT_FOUND', 'Conversation does not exist');
    const binding = this.sql.prepare('SELECT worker_id FROM execution_threads WHERE thread_id=?').get(thread.id);
    return { ...thread, workerId: binding?.worker_id ?? null,
      currentRun: thread.currentRun ? this.getRun(thread.currentRun.id) : null };
  }
  listThreads() { return this.database.listAiChatThreads().map(thread => this.decorate(thread)); }
  getThread(id) { return this.decorate(this.database.getAiChatThread(id)); }
  getRun(id) {
    const run = this.database.getAiChatRun(id);
    if (!run) fail(404, 'RUN_NOT_FOUND', 'Execution does not exist');
    const job = this.sql.prepare('SELECT * FROM execution_jobs WHERE run_id=?').get(id);
    const worker = job ? this.workers().find(item => item.id === job.worker_id) : null;
    return { ...run, executionStatus: job?.state === 'running' && !worker?.online ? 'disconnected' : job?.state,
      workerId: job?.worker_id, cancelRequested: Boolean(job?.cancel_requested) };
  }
  getThreadSummary(id) { return { thread: this.getThread(id), runs: this.database.listAiChatRuns(id).map(run => this.getRun(run.id)) }; }
  getThreadSnapshot(id) { return { ...this.getThreadSummary(id), events: this.database.listAiChatEvents(id) }; }
  subscribe(id, listener) {
    const listeners = this.listeners.get(id) ?? new Set();
    listeners.add(listener); this.listeners.set(id, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(id); };
  }
  emit(id, event) { for (const listener of this.listeners.get(id) ?? []) listener(event); }
  createThread(input) {
    const issue = input.issueId ? this.database.getTask(input.issueId) : null;
    if (input.issueId && (!issue || issue.projectId !== input.projectId || issue.archivedAt)) {
      fail(404, 'AI_CHAT_ISSUE_NOT_FOUND', 'Task does not belong to this active project');
    }
    if (issue && !input.newConversation) {
      const current = this.sql.prepare('SELECT thread_id FROM execution_tasks WHERE task_id=?').get(issue.id);
      if (current) return this.getThread(current.thread_id);
    }
    const resolved = this.target(input.projectId, input.workerId, input.issueId);
    const model = resolved.catalog.models.find(model => model.slug === input.model)
      ?? (!input.model ? resolved.catalog.models.find(model => model.isDefault) ?? resolved.catalog.models[0] : null);
    if (!model) fail(400, 'INVALID_MODEL', 'Model is not available on this worker');
    const reasoningEffort = input.reasoningEffort ?? model.defaultReasoningEffort;
    this.validateSettings(resolved.catalog, { model: model.slug, reasoningEffort, sandbox: input.sandbox ?? 'workspace-write' });
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const thread = this.database.createAiChatThread({ title: input.title ?? issue?.identifier ?? 'New conversation',
        origin: { projectId: resolved.project.id, projectName: resolved.project.name,
          workspacePath: resolved.workspacePath, ...(issue ? { issueId: issue.id, issueIdentifier: issue.identifier } : {}) },
        model: model.slug, reasoningEffort, sandbox: input.sandbox ?? 'workspace-write' });
      this.sql.prepare('INSERT INTO execution_threads VALUES (?,?)').run(thread.id, resolved.workerId);
      if (issue) this.sql.prepare(`INSERT INTO execution_tasks VALUES (?,?) ON CONFLICT(task_id)
        DO UPDATE SET thread_id=excluded.thread_id`).run(issue.id, thread.id);
      this.sql.exec('COMMIT');
      return this.getThread(thread.id);
    } catch (error) { this.sql.exec('ROLLBACK'); throw error; }
  }
  validateSettings(catalog, settings) {
    const model = catalog.models.find(model => model.slug === settings.model);
    if (!model || !model.supportedReasoningEfforts.some(e => (typeof e === 'string' ? e : e.reasoningEffort) === settings.reasoningEffort)) {
      fail(400, 'INVALID_MODEL_SETTINGS', 'Model or reasoning effort is unavailable on the worker');
    }
    if (!['read-only','workspace-write','danger-full-access'].includes(settings.sandbox)) fail(400, 'INVALID_SANDBOX', 'Invalid sandbox');
  }
  updateThread(id, changes) {
    const thread = this.getThread(id);
    if (thread.currentRun) fail(409, 'AI_CHAT_BUSY', 'Wait for the current execution');
    if (!thread.workerId) fail(409, 'WORKER_BINDING_REQUIRED', 'This historical conversation has no worker binding');
    this.validateSettings(JSON.parse(this.worker(thread.workerId).catalog), { ...thread, ...changes });
    return this.decorate(this.database.updateAiChatThread(id, changes));
  }
  deleteThread(id) {
    if (this.getThread(id).currentRun) fail(409, 'AI_CHAT_BUSY', 'Stop execution before deleting its conversation');
    return this.database.deleteAiChatThread(id);
  }
  compactThread() { fail(409, 'REMOTE_COMPACT_UNAVAILABLE', 'Explicit compaction is not available for worker execution'); }
  startTurn(id, input) {
    const thread = this.getThread(id);
    if (input.contractVersion === 'composer.v1') {
      if (input.document.nodes.some(node => node.type !== 'text')) fail(400, 'REMOTE_REFERENCE_UNAVAILABLE', 'Remote execution currently accepts plain text');
      input = { ...input, message: input.document.nodes.map(node => node.text).join(''), skillIds: [] };
    }
    if (typeof input.message !== 'string' || (!input.message.trim() && !input.attachments?.length)) fail(400, 'INVALID_MESSAGE', 'Enter a message');
    if (thread.currentRun) fail(409, 'AI_CHAT_BUSY', 'This conversation already has an execution');
    if (!thread.workerId) fail(409, 'WORKER_BINDING_REQUIRED', 'This historical conversation has no worker binding');
    if (input.skillIds?.length) fail(400, 'REMOTE_SKILL_UNAVAILABLE', 'Use plain text; remote skill selection is not available');
    if (thread.sandbox === 'danger-full-access' && input.dangerFullAccessConfirmed !== true) {
      fail(400, 'CONFIRMATION_REQUIRED', 'Confirm full access before executing');
    }
    const runId = randomUUID(), timestamp = now();
    const issue = thread.origin.issueId ? this.database.getTask(thread.origin.issueId) : null;
    if (thread.origin.issueId && (!issue || issue.archivedAt || issue.projectId !== thread.origin.projectId)) {
      fail(409, 'AI_CHAT_ISSUE_NOT_FOUND', 'Task is no longer active in this project');
    }
    const payload = { thread, input: { ...input, attachments: (input.attachments ?? []).map(a => ({ filename:a.filename, contentType:a.contentType, dataBase64:a.data.toString('base64') })) }, issue: issue ? { identifier: issue.identifier, title: issue.title, description: issue.description } : null };
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      this.sql.prepare(`INSERT INTO ai_chat_runs (id,thread_id,status,started_at) VALUES (?,?,'running',?)`).run(runId,id,timestamp);
      this.sql.prepare(`UPDATE ai_chat_threads SET status='running',updated_at=? WHERE id=?`).run(timestamp,id);
      this.sql.prepare(`INSERT INTO execution_jobs (run_id,worker_id,payload,state,created_at) VALUES (?,?,?,'queued',?)`)
        .run(runId,thread.workerId,JSON.stringify(payload),timestamp);
      this.database.insertAiChatEvent({ threadId:id,runId,type:'user_message',role:'user',content:input.message });
      this.sql.exec('COMMIT');
    } catch (error) { this.sql.exec('ROLLBACK'); throw error; }
    const run = this.getRun(runId); this.emit(id,{type:'ai.run',run}); return run;
  }
  heartbeat(workerId) {
    this.worker(workerId);
    this.sql.prepare('UPDATE execution_workers SET last_seen=? WHERE id=?').run(Date.now(),workerId);
    return { cancelRunIds:this.sql.prepare("SELECT run_id FROM execution_jobs WHERE worker_id=? AND state='running' AND cancel_requested=1").all(workerId).map(row=>row.run_id) };
  }
  claim(workerId) {
    this.worker(workerId);
    this.sql.prepare('UPDATE execution_workers SET last_seen=? WHERE id=?').run(Date.now(),workerId);
    // Return the same claim after a lost response; never reassign a started job to another worker.
    let job = this.sql.prepare(`SELECT * FROM execution_jobs WHERE worker_id=? AND state='running' ORDER BY created_at LIMIT 1`).get(workerId);
    if (!job) {
      job = this.sql.prepare(`SELECT * FROM execution_jobs WHERE worker_id=? AND state='queued' ORDER BY created_at,run_id LIMIT 1`).get(workerId);
      if (job) this.sql.prepare(`UPDATE execution_jobs SET state='running' WHERE run_id=?`).run(job.run_id);
    }
    return job ? { runId:job.run_id, ...JSON.parse(job.payload), cancelRequested:Boolean(job.cancel_requested) } : null;
  }
  report(workerId, runId, input) {
    const job = this.sql.prepare('SELECT * FROM execution_jobs WHERE run_id=? AND worker_id=?').get(runId,workerId);
    if (!job) fail(404,'RUN_NOT_FOUND','Worker does not own this execution');
    this.sql.prepare('UPDATE execution_workers SET last_seen=? WHERE id=?').run(Date.now(),workerId);
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) fail(400,'INVALID_SEQUENCE','Invalid event sequence');
    if (input.sequence <= job.sequence) return { accepted:true, cancelRequested:Boolean(job.cancel_requested) };
    if (input.sequence !== job.sequence+1 || job.state !== 'running') fail(409,'INVALID_SEQUENCE','Execution event is out of order');
    const run = this.getRun(runId);
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      if (input.threadId) {
        if (typeof input.threadId !== 'string' || !idPattern.test(input.threadId)) fail(400,'INVALID_THREAD','Invalid Codex thread id');
        const current = this.getThread(run.threadId);
        if (current.codexThreadId && current.codexThreadId !== input.threadId) fail(409,'THREAD_MISMATCH','Worker changed the conversation');
        this.database.updateAiChatThread(run.threadId,{codexThreadId:input.threadId});
      }
      if (input.event) {
        const e = input.event;
        if (!['assistant','activity','error'].includes(e.role) || typeof e.type !== 'string' || typeof e.content !== 'string') {
          fail(400,'INVALID_EVENT','Invalid execution event');
        }
        this.database.insertAiChatEvent({threadId:run.threadId,runId,type:e.type,role:e.role,content:e.content,data:e.data});
      }
      if (input.result) {
        const result = input.result;
        if (!['completed','failed','interrupted'].includes(result.status)) fail(400,'INVALID_RESULT','Invalid execution result');
        this.sql.prepare(`UPDATE ai_chat_runs SET status=?,exit_code=?,error=?,finished_at=? WHERE id=?`)
          .run(result.status,Number.isInteger(result.exitCode)?result.exitCode:null,String(result.error??'').slice(0,65536)||null,now(),runId);
        this.sql.prepare('UPDATE ai_chat_threads SET status=?,updated_at=? WHERE id=?').run(result.status==='failed'?'failed':'idle',now(),run.threadId);
        this.sql.prepare('UPDATE execution_jobs SET state=? WHERE run_id=?').run(result.status,runId);
      }
      this.sql.prepare('UPDATE execution_jobs SET sequence=? WHERE run_id=?').run(input.sequence,runId);
      this.sql.exec('COMMIT');
    } catch (error) { this.sql.exec('ROLLBACK'); throw error; }
    if (input.result) this.lastExecutionStates.delete(runId);
    this.emit(run.threadId,{type:'ai.run',run:this.getRun(runId)});
    this.emit(run.threadId,{type:'ai.event'});
    return {accepted:true,cancelRequested:Boolean(job.cancel_requested)};
  }
  interrupt(runId) {
    const run = this.getRun(runId);
    if (run.status !== 'running') return run;
    this.sql.prepare('UPDATE execution_jobs SET cancel_requested=1 WHERE run_id=?').run(runId);
    const job = this.sql.prepare('SELECT state FROM execution_jobs WHERE run_id=?').get(runId);
    if (job?.state === 'queued') {
      this.database.updateAiChatRun(runId,{status:'interrupted',finishedAt:now()});
      this.sql.prepare(`UPDATE execution_jobs SET state='interrupted' WHERE run_id=?`).run(runId);
    }
    return this.getRun(runId);
  }
  async close() { clearInterval(this.statusTimer); this.listeners.clear(); }
}
