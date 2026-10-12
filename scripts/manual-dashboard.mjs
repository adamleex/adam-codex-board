#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTaskboardServer } from '../server/app.mjs';
import { withoutTaskboardLauncherEnvironment } from '../shared/codex-environment.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const data = path.join(root, '.data', 'manual');
const port = Number(process.env.ADAM_DASHBOARD_PORT ?? 47830);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ADAM_DASHBOARD_PORT must be 1..65535');

async function main() {
  // This entry point owns both processes. It does not install a service or touch an existing board.
  const build = process.env.npm_execpath
    ? spawnSync(process.execPath, [process.env.npm_execpath, 'run', 'build:web'], { cwd:root, stdio:'inherit' })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:web'], { cwd:root, stdio:'inherit' });
  if (build.status !== 0) throw new Error('Web build failed');
  await mkdir(data, { recursive:true, mode:0o700 });
  const tokenFile = path.join(data, 'service-token');
  let token;
  try { token = await readFile(tokenFile, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    token = randomBytes(32).toString('hex');
    await writeFile(tokenFile, token, { mode:0o600, flag:'wx' });
  }
  const environment = withoutTaskboardLauncherEnvironment(process.env);
  const app = createTaskboardServer({ mode:'central', serviceToken:token, dataDirectory:data, processEnv:environment });
  let worker;
  let stopping;
  const stop = () => stopping ??= (async () => {
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      const exited = once(worker, 'exit');
      worker.kill('SIGTERM');
      await exited;
    }
    await app.close();
  })();
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
  try {
    await app.listen({ host:'127.0.0.1', port });
    const url = `http://127.0.0.1:${port}`;
    const headers = { authorization:`Bearer ${token}`, 'content-type':'application/json' };
    const post = async (route, body) => {
      const response = await fetch(url + route, { method:'POST', headers, body:JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message ?? 'Could not initialize manual workspace');
      return payload;
    };
    let project = app.database.listProjects().find(candidate => candidate.workspacePath === root);
    if (!project) {
      ({ project } = await post('/api/projects', { name:'Adam Dashboard', workspacePath:root }));
      for (const letter of ['A', 'B']) {
        await post('/api/tasks', { projectId:project.id, title:`会话试用 ${letter}`, status:'todo',
          description:`这是独立试用数据，不是原看板任务。打开任务会话，发送一条消息，再切换到另一任务并返回，检查历史是否保持独立。此任务不要求修改代码。` });
      }
    }
    worker = spawn(process.execPath, [path.join(root, 'scripts/execution-worker.mjs')], {
      cwd:root, stdio:'inherit', env:{ ...environment,
        CODEX_TASKBOARD_SERVER_URL:url, CODEX_TASKBOARD_SERVICE_TOKEN:token,
        CODEX_TASKBOARD_WORKER_ID:'manual-local', CODEX_TASKBOARD_WORKER_NAME:'本机执行端',
        CODEX_TASKBOARD_WORKSPACE_ROOTS:JSON.stringify([root]),
        CODEX_TASKBOARD_WORKER_DATA_DIR:path.join(data, 'worker'),
      },
    });
    worker.once('error', error => { console.error(error.message); process.exitCode=1; void stop(); });
    worker.once('exit', () => { if (!stopping) { process.exitCode=1; void stop(); } });
    const deadline = Date.now() + 30_000;
    while (!app.aiChat.workers().some(candidate => candidate.id === 'manual-local' && candidate.online)) {
      if (stopping || Date.now() > deadline) throw new Error('Local worker did not become ready; check its Codex login and startup output');
      await sleep(200);
    }
    const access = { url:`${url}/?project=${encodeURIComponent(project.id)}`, username:'adam-dashboard', password:token };
    await writeFile(path.join(data, 'access.json'), JSON.stringify(access,null,2)+'\n', {mode:0o600});
    console.log(`\nAdam Dashboard: ${access.url}\nUsername: ${access.username}\nPassword: ${token}\n\nCtrl+C stops both processes. Conversations persist in ${data}.\nThe two starter tasks are isolated trial data; the original board is unchanged.\n`);
  } catch (error) { await stop(); throw error; }
}
main().catch(error => { console.error(error.message); process.exitCode=1; });
