// macOS sandbox for a trial: deny by default, one throwaway folder, no real home,
// no Internet, a list of localhost ports. Poney has no sandbox of its own and
// `--yes` runs anything: this file is the only thing between a model and the machine.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NODE, PONEY_DIR } from './config.js';

const CLT = '/Library/Developer/CommandLineTools/usr/bin'; // (the /usr/bin stubs print xcrun noise in a sandbox)
const quote = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export const sandboxBase = async () => {
  const base = path.join(await fs.realpath(os.tmpdir()), 'tambouille');
  await fs.mkdir(base, { recursive: true });
  return base;
};

/** A new root: `work` (the project), `home`, `tmp` writable, `ctl` readable only (key, settings, script). */
export async function createRoot(id) {
  const root = path.join(await sandboxBase(), id.replace(/[^\w.-]+/g, '_'));
  await fs.rm(root, { recursive: true, force: true });
  const dirs = { root, work: path.join(root, 'work'), home: path.join(root, 'home'), tmp: path.join(root, 'tmp'), ctl: path.join(root, 'ctl') };
  for (const d of Object.values(dirs)) await fs.mkdir(d, { recursive: true });
  await fs.writeFile(path.join(dirs.home, '.gitconfig'), '[user]\n\tname = Bench Agent\n\temail = agent@bench.invalid\n[init]\n\tdefaultBranch = main\n');
  await fs.writeFile(path.join(dirs.home, '.bash_profile'), `export PATH="${path.dirname(NODE)}:${CLT}:$PATH"\n`);
  return dirs;
}

export const removeRoot = (dirs) => fs.rm(dirs.root, { recursive: true, force: true });

/** The profile. In SBPL the last matching rule wins, for the same operation: `file-read*` does not undo a `deny file-read-data`. */
export function profile({ dirs, readable = [], ports = [] }) {
  const nodeHome = path.dirname(path.dirname(NODE));
  const read = [nodeHome, PONEY_DIR, dirs.root, ...readable];
  const parents = []; // (getcwd reads each folder above the project)
  for (let p = path.dirname(dirs.root); p !== '/'; p = path.dirname(p)) parents.push(p);
  return `(version 1)
(deny default)
(allow process-fork)
(allow process-exec)
(deny process-exec (literal "/usr/bin/osascript") (literal "/usr/bin/open") (literal "/usr/bin/security") (literal "/bin/launchctl"))
(allow signal (target same-sandbox))
(allow sysctl-read)
(allow file-read*)
(deny file-read-data (subpath "/Users") (subpath "/Volumes") (subpath "/private/var/folders") (subpath "/private/tmp"))
(allow file-read-metadata (subpath "/Users") (subpath "/private/var/folders") (subpath "/private/tmp"))
${read.map((p) => `(allow file-read-data ${/\.gguf$/.test(p) ? `(literal ${quote(p)})` : `(subpath ${quote(p)})`})`).join('\n')}
${parents.map((p) => `(allow file-read-data (literal ${quote(p)}))`).join('\n')}
(allow file-write* (subpath ${quote(dirs.work)}) (subpath ${quote(dirs.home)}) (subpath ${quote(dirs.tmp)}))
(allow file-write-data (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper"))
(allow file-ioctl (literal "/dev/null") (literal "/dev/tty"))
(allow system-socket)
(allow ipc-posix-shm-read-data ipc-posix-shm-read-metadata)
(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.system.notification_center") (global-name "com.apple.logd") (global-name "com.apple.system.logger"))
${ports.map((p) => `(allow network-outbound (remote ip "localhost:${p}"))`).join('\n')}
`;
}

export const sandboxEnv = (dirs) => ({
  HOME: dirs.home,
  TMPDIR: dirs.tmp,
  SHELL: '/bin/bash',
  PATH: `${path.dirname(NODE)}:${CLT}:/usr/bin:/bin:/usr/sbin:/sbin`,
  LANG: 'en_US.UTF-8',
  PONEY_NODE: NODE,
});

/** The command line and clean environment of `argv` in this sandbox. */
export async function wrap(argv, { dirs, readable, ports }) {
  const file = path.join(dirs.ctl, 'profile.sb');
  await fs.writeFile(file, profile({ dirs, readable, ports }));
  return { cmd: ['/usr/bin/sandbox-exec', '-f', file, ...argv], env: sandboxEnv(dirs) };
}

/** A shell command in the sandbox (verifiers run the agent's code there too). */
export async function shell(command, { dirs, readable, ports, timeoutMs = 120000 }) {
  const { cmd, env } = await wrap(['/bin/bash', '-lc', command], { dirs, readable, ports });
  const p = Bun.spawn(cmd, { cwd: dirs.work, env, stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  return { code, stdout, stderr, out: stdout + stderr };
}

/**
 * Proves the sandbox holds, with real attempts: run before every campaign. What
 * must work works, what must fail fails, each listed. A secret is planted outside
 * the root and a port is left off the list.
 */
export async function canary() {
  const dirs = await createRoot(`canary-${process.pid}`);
  const outside = path.join(os.homedir(), `.tambouille-canary-${process.pid}`);
  await fs.writeFile(outside, 'secret');
  const handler = () => new Response('ok');
  const allowed = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: handler });
  const forbidden = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: handler });
  const ports = [allowed.port];
  const attempt = async (name, command, wanted) => {
    const r = await shell(command, { dirs, ports, timeoutMs: 20000 });
    return { name, ok: wanted === 'works' ? r.code === 0 : r.code !== 0, wanted, detail: r.out.trim().slice(0, 160) };
  };
  try {
    const flag = path.join(os.homedir(), `.tambouille-canary-write-${process.pid}`);
    const checks = [
      await attempt('writes in the project', 'echo x > ok.txt && cat ok.txt', 'works'),
      await attempt('runs git', 'git init -q . && git add . && git commit -qm x', 'works'),
      await attempt('runs node', 'node -e "1"', 'works'),
      await attempt('runs python', 'python3 -c "1"', 'works'),
      await attempt('reaches a listed port', `curl -sf -m 5 http://127.0.0.1:${allowed.port}/`, 'works'),
      await attempt('reads a file of the real home', `cat ${outside}`, 'fails'),
      await attempt('reads the Poney settings', `cat ${JSON.stringify(path.join(os.homedir(), 'Library/Application Support/poney/settings.json'))}`, 'fails'),
      await attempt('writes in the real home', `touch ${flag}`, 'fails'),
      await attempt('writes in /tmp', `touch /private/tmp/tambouille-canary-${process.pid}`, 'fails'),
      await attempt('writes in its own control folder', `touch ${path.join(dirs.ctl, 'x')}`, 'fails'),
      await attempt('reaches an unlisted port', `curl -sf -m 5 http://127.0.0.1:${forbidden.port}/`, 'fails'),
      await attempt('reaches the Internet', 'curl -sf -m 5 https://1.1.1.1/ -o /dev/null', 'fails'),
      await attempt('resolves a name', 'curl -sf -m 5 https://example.com/ -o /dev/null', 'fails'),
      await attempt('signals a process outside', 'kill -0 1', 'fails'),
      await attempt('opens an app', 'open -a Finder', 'fails'),
      await attempt('talks to launchd', 'launchctl list | grep -q .', 'fails'),
      await attempt('sends an Apple event', 'osascript -e \'tell application "System Events" to get name of every process\'', 'fails'),
    ];
    if (await fs.stat(flag).catch(() => null)) {
      await fs.rm(flag);
      checks.find((c) => c.name === 'writes in the real home').ok = false;
    }
    return { ok: checks.every((c) => c.ok), checks };
  } finally {
    allowed.stop(true);
    forbidden.stop(true);
    await fs.rm(outside, { force: true });
    await removeRoot(dirs);
  }
}
