import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../scripts/dashboard.mjs', import.meta.url), 'utf8');

async function launch({ ready = false, args = [] } = {}) {
  const root = '/work/adam-dashboard';
  const data = '/existing-board/.data';
  const calls = [];
  const writes = [];
  const process = new EventEmitter();
  Object.assign(process, {
    argv: ['/node', `${root}/scripts/dashboard.mjs`, ...args],
    execPath: '/node', platform: 'darwin', env: { npm_execpath: '/npm/cli.js' },
  });
  const program = source.replace(/^#!.*\n/, '').replace(/^import .*;\n/gm, '')
    .replace(/^const root = .*;\n/m, '')
    .replace(/main\(\)\.catch\(error => \{.*\}\);\s*$/, 'return main();');
  await vm.runInNewContext(`(async () => { ${program} })()`, {
    root, path, process, URL, AbortSignal, setTimeout,
    console: { log() {} },
    readFile: async file => {
      if (file === `${root}/.data/dashboard.json`) return JSON.stringify({ dataDirectory: data });
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    readRemoteBridges: async () => [],
    writeFile: async (...args) => writes.push(args),
    mkdir: async () => {},
    existsSync: () => true,
    withoutTaskboardLauncherEnvironment: env => ({ ...env }),
    execFileSync: () => `/Applications/ChatGPT.app/Contents/MacOS/ChatGPT${ready ? ' --remote-debugging-port=9231' : ''}\n`,
    fetch: async () => ({ ok: ready }),
    spawn: (command, args, options) => {
      calls.push({ command, args: Array.from(args), env: options.env });
      if (command === '/usr/bin/open') ready = true;
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 0));
      return child;
    },
  });
  return { calls, writes, data };
}

test('npm dashboard starts a debugging window and attaches using the saved original database', async () => {
  const { calls, writes, data } = await launch();
  const opened = calls.find(call => call.command === '/usr/bin/open');
  assert.ok(opened, 'Codex must start when its debugging port is unavailable');
  assert.deepEqual(opened.args.slice(0, 5), ['-n', '-a', '/Applications/ChatGPT.app', '--args', '--user-data-dir=/work/adam-dashboard/.data/codex-profile']);
  assert.ok(opened.args.includes('--remote-debugging-port=9231'));
  assert.ok(opened.args.includes('--remote-debugging-address=127.0.0.1'));
  const injection = calls.at(-1);
  assert.ok(injection.args.includes('--attach-existing'));
  assert.ok(injection.args.includes('--open'));
  assert.deepEqual(injection.args.slice(-2), ['--app-path', '/Applications/ChatGPT.app']);
  assert.equal(injection.env.CODEX_TASKBOARD_DATA_DIR, data);
  assert.equal(injection.env.CODEX_TASKBOARD_RUNTIME_FILE, '/work/adam-dashboard/.data/launcher-runtime.json');
  assert.equal(writes.length, 0, 'starting must not replace the saved database configuration');
});

test('npm dashboard reuses a debugging window and keeps the original database', async () => {
  const { calls, data } = await launch({ ready: true });
  assert.equal(calls.some(call => call.command === '/usr/bin/open'), false);
  assert.equal(calls.at(-1).env.CODEX_TASKBOARD_DATA_DIR, data);
});

test('dashboard --check does not start Codex or the dashboard', async () => {
  const { calls, writes } = await launch({ args: ['--check'] });
  assert.deepEqual(calls, []);
  assert.deepEqual(writes, []);
});
