import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const remoteProgram = `import sys,json,pathlib,os,urllib.request
payload=json.loads(sys.stdin.readline())
filename=payload.pop('runtimeFilename')
p=pathlib.Path.home()/'.config/adam-dashboard'/filename
p.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
with urllib.request.urlopen(payload['url'].rstrip('/')+'/api/projects',timeout=10) as r:
 if r.status!=200: raise RuntimeError('Board unreachable')
tmp=p.with_suffix('.tmp')
fd=os.open(str(tmp),os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
with os.fdopen(fd,'w') as f: json.dump(payload,f)
os.chmod(tmp,0o600)
os.replace(tmp,p)
print('ready',flush=True)
try: sys.stdin.read()
finally:
 if p.exists() and json.loads(p.read_text())==payload: p.unlink()
`;

export async function readRemoteBridges(directory) {
  let entries;
  try { entries = JSON.parse(await readFile(path.join(directory, 'remote-bridges.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (!Array.isArray(entries)) throw new Error('remote-bridges.json must contain an array');
  const hosts = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry.codexHostId !== 'string' || !entry.codexHostId.startsWith('remote-ssh-')
      || typeof entry.sshHost !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(entry.sshHost)
      || !Number.isInteger(entry.remotePort) || entry.remotePort < 1024 || entry.remotePort > 65535
      || hosts.has(entry.codexHostId)) throw new Error('Invalid or duplicate remote bridge configuration');
    hosts.add(entry.codexHostId);
  }
  return entries;
}

export function startRemoteBridges({ entries, url, directory, runtimeFilename = "launcher-runtime.json", log = console.log }) {
  if (!/^[a-zA-Z0-9-]+\.json$/.test(runtimeFilename)) throw new Error("Invalid runtime filename");
  const local = new URL(url);
  if (local.protocol !== 'http:' || local.hostname !== '127.0.0.1' || !local.port) throw new Error('Bridge requires a loopback board URL');
  let stopped = false;
  const children = new Set();
  const timers = new Set();
  const jobs = new Set();
  const launch = async (entry, index) => {
    if (stopped) return;
    let child;
    try {
      const resolved = execFileSync('ssh', ['-G', entry.sshHost], { encoding: 'utf8', timeout: 15000 });
      const config = resolved.split('\n').filter(line => !/^(localforward|remoteforward|dynamicforward)\s/i.test(line)).join('\n');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const configPath = path.join(directory, `remote-bridge-${index}.ssh`);
      await writeFile(configPath, config, { mode: 0o600 });
      if (stopped) return;
      child = spawn('ssh', ['-F', configPath, '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
        '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
        '-R', `127.0.0.1:${entry.remotePort}:127.0.0.1:${local.port}`, entry.sshHost,
        'python3 -c ' + quote(remoteProgram)], { stdio: ['pipe', 'pipe', 'pipe'] });
      children.add(child);
      child.stdin.on('error', () => {});
      let ready = false;
      child.stdout.on('data', data => {
        if (!ready && data.toString().includes('ready')) { ready = true; log(`Remote board connected: ${entry.codexHostId}`); }
      });
      // SSH diagnostics never include the private runtime URL sent over stdin.
      child.stderr.on('data', data => log(`Remote bridge ${entry.codexHostId}: ${data.toString().trim()}`));
      const remote = new URL(local); remote.port = String(entry.remotePort);
      child.stdin.write(JSON.stringify({ version: 1, url: remote.href, runtimeFilename }) + '\n');
      await new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
    } catch (error) { log(`Remote bridge ${entry.codexHostId}: ${error.message}`); }
    finally { if (child) children.delete(child); }
    if (!stopped) {
      log(`Remote board disconnected: ${entry.codexHostId}; reconnecting`);
      const timer = setTimeout(() => { timers.delete(timer); schedule(entry, index); }, 5000);
      timers.add(timer);
    }
  };
  const schedule = (entry, index) => {
    const job = launch(entry, index); jobs.add(job); void job.finally(() => jobs.delete(job));
  };
  entries.forEach(schedule);
  return { async stop() {
    stopped = true;
    for (const timer of timers) clearTimeout(timer);
    for (const child of children) child.kill('SIGTERM');
    await Promise.allSettled([...jobs]);
  } };
}
