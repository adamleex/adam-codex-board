#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { withoutTaskboardLauncherEnvironment } from '../shared/codex-environment.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readRemoteBridges } from './dashboard-remote-bridge.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--help') {
    console.log(`Adam Dashboard — Codex sidebar and remote board connection

npm run dashboard
npm run dashboard -- --ssh-host HOST --host-id CODEX_HOST_ID

Options:
  --ssh-host HOST       Save the SSH target for one Codex remote host
  --host-id ID          Exact remote host ID from Codex
  --remote-port PORT    Remote loopback board port (default 47836)
  --cdp-port PORT       Existing Codex debugging port (default 9231)
  --data-dir PATH       Save the existing board data directory
  --share-origin URL    Save the origin of an already configured sharing reverse proxy
  --check               Check configuration without starting any processes

Configuration: .data/remote-bridges.json (saved once).
Ctrl+C stops the processes started by this command.
An existing debugging-enabled Codex instance is required.`);
    process.exit(0);
  }
  if (args[i] === '--check') { options.check = true; continue; }
  if (!['--data-dir', '--ssh-host', '--host-id', '--remote-port', '--cdp-port', '--share-origin'].includes(args[i]) || !args[i+1]) throw new Error(`Unknown or incomplete option: ${args[i]}`);
  options[args[i].slice(2)] = args[++i];
}
const configDirectory = path.join(root, '.data');
let settings = {};
try { settings = JSON.parse(await readFile(path.join(configDirectory, 'dashboard.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const data = path.resolve(options['data-dir'] ?? settings.dataDirectory ?? configDirectory);
const shareOrigin = options['share-origin'] ?? settings.shareOrigin ?? process.env.ADAM_DASHBOARD_SHARE_ORIGIN ?? '';
if (shareOrigin) {
  const url = new URL(shareOrigin);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Share origin must be an HTTP(S) origin without a path or credentials');
}
const cdpPort = Number(options['cdp-port'] ?? 9231);
if (!Number.isInteger(cdpPort) || cdpPort < 1 || cdpPort > 65535) throw new Error('Invalid CDP port');
if (Boolean(options['ssh-host']) !== Boolean(options['host-id'])) throw new Error('--ssh-host and --host-id must be supplied together');
let child;
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stopping = true; child?.kill(signal); });
async function run(command, args, env = process.env) {
  if (stopping) return;
  await new Promise((resolve, reject) => {
    child = spawn(command, args, { cwd: root, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => { child = null; code === 0 || stopping ? resolve() : reject(new Error(`${path.basename(command)} exited (${signal ?? code})`)); });
  });
}
async function main() {
  if (options['share-origin']) {
    settings = { ...settings, shareOrigin };
    await mkdir(configDirectory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(configDirectory, 'dashboard.json'), JSON.stringify(settings, null, 2)+'\n', { mode:0o600 });
  }
  if (options['data-dir']) {
    if (!existsSync(path.join(data, 'taskboard.sqlite'))) throw new Error('The selected data directory has no taskboard.sqlite');
    await mkdir(configDirectory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(configDirectory, 'dashboard.json'), JSON.stringify({ ...settings, dataDirectory: data },null,2)+'\n', { mode:0o600 });
  }
  if (options['ssh-host']) {
    const entries = await readRemoteBridges(configDirectory);
    const entry = { sshHost: options['ssh-host'], codexHostId: options['host-id'], remotePort: Number(options['remote-port'] ?? 47836) };
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(entry.sshHost) || !entry.codexHostId.startsWith('remote-ssh-') || !Number.isInteger(entry.remotePort) || entry.remotePort < 1024 || entry.remotePort > 65535) throw new Error('Invalid remote connection settings');
    const next = [...entries.filter(value => value.codexHostId !== entry.codexHostId), entry];
    await mkdir(configDirectory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(configDirectory, 'remote-bridges.json'), JSON.stringify(next,null,2)+'\n', { mode:0o600 });
  }
  const entries = await readRemoteBridges(configDirectory);
  console.log(`Board data: ${data}\nRemote hosts: ${entries.map(entry => entry.codexHostId).join(', ') || 'none configured'}`);
  // A real existing launcher owns this database; never run two injectors against it.
  for (const descriptor of new Set([path.join(data, 'launcher-runtime.json'), path.join(configDirectory, 'launcher-runtime.json')])) {
    let runtime;
    try { runtime = JSON.parse(await readFile(descriptor, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!Number.isInteger(runtime.pid) || runtime.pid < 1) continue;
    let alive = false;
    try { process.kill(runtime.pid, 0); alive = true; } catch (error) { if (error.code !== 'ESRCH') throw error; }
    if (alive) throw new Error(`An existing launcher (PID ${runtime.pid}) owns ${descriptor}. Stop that launcher in its terminal before starting Adam Dashboard. No processes were stopped.`);
  }
  if (options.check) { console.log('Configuration ready. No processes started.'); return; }
  const npm = process.env.npm_execpath;
  const npmCommand = npm ? process.execPath : 'npm';
  const npmArgs = npm ? [npm] : [];
  if (!existsSync(path.join(root, 'node_modules'))) await run(npmCommand, [...npmArgs, 'ci']);
  await run(npmCommand, [...npmArgs, 'run', 'build:web']);
  await run(process.execPath, [path.join(root, 'scripts/codex-injector.mjs'), '--attach-existing', '--watch', '--open', '--port', String(cdpPort)], {
    ...withoutTaskboardLauncherEnvironment(process.env), CODEX_TASKBOARD_DATA_DIR:data, CODEX_TASKBOARD_HOST:'127.0.0.1',
    CODEX_TASKBOARD_RUNTIME_FILE:path.join(configDirectory, 'launcher-runtime.json'),
    CODEX_TASKBOARD_PORT:'47834', ADAM_DASHBOARD_CONFIG_DIR:configDirectory,
    ADAM_DASHBOARD_SHARE_ORIGIN:shareOrigin,
  });
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
