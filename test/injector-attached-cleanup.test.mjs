import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../scripts/codex-injector.mjs', import.meta.url), 'utf8');
const start = source.indexOf('  let cleanupPromise = null;');
const end = source.indexOf('  if (options.watch) {', start);
const cleanup = source.slice(start, end);

async function shutdown(attachExisting) {
  const stopped = [];
  const existing = { pid: 123, command: '/Applications/ChatGPT.app --user-data-dir=managed --remote-debugging-port=9231' };
  await vm.runInNewContext(`(async () => {
    const injectedTargets = new Map();
    let cdpRuntime = null, remoteBridges = null, runtimePublishPromise = null;
    let pendingCodexLaunch = null, codexProcess = null, managedCodex = null;
    ${cleanup}
    await cleanup();
  })()`, {
    options: { attachExisting, cdpPipe: false, port: 9231, appPath: '/Applications/ChatGPT.app' },
    supervisor: { stop: async () => {} },
    removeTaskboardRuntime: async () => {},
    managedCodexProcess: () => existing,
    managedCodexUsesPort: () => true,
    stopManagedCodex: async record => stopped.push(record.pid),
  });
  return stopped;
}

test('stopping an attached injector preserves Codex even with a managed profile', async () => {
  assert.deepEqual(await shutdown(true), []);
  assert.deepEqual(await shutdown(false), [123]);
});
