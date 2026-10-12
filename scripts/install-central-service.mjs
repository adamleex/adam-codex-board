#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const help = `Render opt-in Adam Dashboard Linux systemd user services (no installation by default).
Usage: node scripts/install-central-service.mjs --role central|worker --output-dir DIR [options]
  --repo-dir DIR       Checkout on the target machine (default: this checkout)
  --node PATH          Target Node >=22.5 executable (default: current Node)
  --token-file FILE    Shared token, or set CODEX_TASKBOARD_SERVICE_TOKEN
  --data-dir DIR       Persistent service data directory
  --port NUMBER        Central loopback port (default: 47823)
  --public-origin URL  Exact HTTPS origin of the central reverse proxy
  --server-url URL     Worker endpoint: HTTPS, or loopback HTTP
  --worker-id ID       Worker identity (default: hostname)
  --worker-name NAME   Display name (default: worker ID)
  --workspace-roots JSON  Worker allowed absolute paths, nonempty JSON array
  --install           Linux only: copy files and enable/start the user unit
  --help              Show help
Render on each target host, or supply that host's absolute paths explicitly.
Use a fresh output directory; existing generated files are never overwritten.`;

function clean(value, label) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f\u2028\u2029]/u.test(value)) {
    throw new Error(`${label} must be nonempty and contain no control characters or newlines`);
  }
  return value;
}
function absolute(value, label) {
  clean(value, label);
  if (!path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  return path.normalize(value);
}
// Unit files expand percent specifiers; ExecStart also expands dollars.
function unitQuote(value, exec = false) {
  let result = clean(value, 'unit value').replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
  if (exec) result = result.replaceAll('$', '$$');
  return `"${result}"`;
}
// EnvironmentFile has shell-like quoting, but no variable/specifier expansion.
function envQuote(value) {
  return `"${clean(value, 'environment value').replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$').replaceAll('`', '\\`')}"`;
}
function privateDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) {
    throw new Error(`Directory must be owned by this user with mode 0700: ${dir}`);
  }
}
function writeNew(file, content) {
  fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600 });
}
function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(help); return; }
  const options = {};
  const values = new Set(['role', 'output-dir', 'repo-dir', 'node', 'token-file', 'data-dir', 'port', 'public-origin', 'server-url', 'worker-id', 'worker-name', 'workspace-roots']);
  for (let i = 0; i < args.length; i++) {
    const key = args[i].slice(2);
    if (args[i] === '--install') { options.install = true; continue; }
    if (!args[i].startsWith('--') || !values.has(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Invalid option: ${args[i]}`);
    options[key] = clean(args[++i], key);
  }
  const role = options.role;
  if (!['central', 'worker'].includes(role)) throw new Error('--role must be central or worker');
  if (options.install && process.platform !== 'linux') throw new Error('--install requires Linux');
  const output = absolute(options['output-dir'], '--output-dir');
  const repo = absolute(options['repo-dir'] ?? fileURLToPath(new URL('..', import.meta.url)), '--repo-dir');
  const node = absolute(options.node ?? process.execPath, '--node');
  const token = clean(options['token-file'] ? fs.readFileSync(absolute(options['token-file'], '--token-file'), 'utf8') : process.env.CODEX_TASKBOARD_SERVICE_TOKEN, 'service token');
  if (token.length < 32) throw new Error('Service token must contain at least 32 characters');
  const data = absolute(options['data-dir'] ?? path.join(os.homedir(), '.local/share/adam-dashboard', role), '--data-dir');
  const env = { CODEX_TASKBOARD_SERVICE_TOKEN: token };
  if (role === 'central') {
    const port = Number(options.port ?? 47823);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be 1..65535');
    if (options['public-origin']) {
      const origin = new URL(clean(options['public-origin'], '--public-origin'));
      if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('--public-origin must be an exact HTTPS origin');
      env.CODEX_TASKBOARD_TRUSTED_ORIGINS = origin.origin;
    }
    Object.assign(env, { CODEX_TASKBOARD_MODE: 'central', CODEX_TASKBOARD_HOST: '127.0.0.1', CODEX_TASKBOARD_PORT: String(port), CODEX_TASKBOARD_DATA_DIR: data });
  } else {
    const server = new URL(clean(options['server-url'], '--server-url'));
    if (server.username || server.password || server.search || server.hash || (server.protocol !== 'https:' && !(server.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(server.hostname)))) throw new Error('--server-url requires HTTPS for remote hosts and no embedded credentials, query or fragment');
    const roots = JSON.parse(options['workspace-roots'] ?? 'null');
    if (!Array.isArray(roots) || !roots.length) throw new Error('--workspace-roots must be a nonempty JSON array');
    const id = clean(options['worker-id'] ?? os.hostname().replace(/[^a-zA-Z0-9_-]/g, '-'), '--worker-id');
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('--worker-id must use 1..128 letters, digits, underscores or hyphens');
    Object.assign(env, { CODEX_TASKBOARD_SERVER_URL: server.href.replace(/\/$/, ''), CODEX_TASKBOARD_WORKER_ID: id, CODEX_TASKBOARD_WORKER_NAME: clean(options['worker-name'] ?? id, '--worker-name'), CODEX_TASKBOARD_WORKSPACE_ROOTS: JSON.stringify(roots.map(root => absolute(root, 'workspace root'))), CODEX_TASKBOARD_WORKER_DATA_DIR: data });
    // User services do not inherit interactive shell setup; retain the rendering user's tool PATH.
    env.PATH = clean(process.env.PATH, 'PATH');
  }
  const name = `adam-dashboard-${role}`;
  const configHome = absolute(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'XDG_CONFIG_HOME');
  const config = path.join(configHome, name);
  const envFile = path.join(options.install ? config : output, `${name}.env`);
  const template = fs.readFileSync(new URL('../deploy/central/taskboard.service.in', import.meta.url), 'utf8');
  const substitutions = { ROLE: role, REPO: unitQuote(repo), ENV_FILE: unitQuote(envFile), NODE: unitQuote(node, true), ENTRY: unitQuote(path.join(repo, role === 'central' ? 'server/index.mjs' : 'scripts/execution-worker.mjs'), true) };
  const unit = template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => substitutions[key]);
  const environment = Object.entries(env).map(([key, value]) => `${key}=${envQuote(value)}`).join('\n') + '\n';
  privateDirectory(output);
  writeNew(path.join(output, `${name}.env`), environment);
  writeNew(path.join(output, `${name}.service`), unit);
  console.log(`Rendered ${name} in ${output} (environment file 0600; directory 0700).`);
  if (!options.install) { console.log('No services installed or started.'); return; }
  privateDirectory(config);
  privateDirectory(data);
  const units = path.join(configHome, 'systemd/user');
  fs.mkdirSync(units, { recursive: true });
  writeNew(envFile, environment);
  writeNew(path.join(units, `${name}.service`), unit);
  for (const command of [['--user', 'daemon-reload'], ['--user', 'enable', '--now', `${name}.service`]]) {
    const result = spawnSync('systemctl', command, { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`systemctl ${command.join(' ')} failed; inspect the installed files and journal`);
  }
  console.log('Enabled user service. Boot/logout persistence requires loginctl enable-linger for this user; see docs/central-service.md.');
}
try { main(); } catch (error) { console.error(`central-service: ${error.message}`); process.exitCode = 1; }
