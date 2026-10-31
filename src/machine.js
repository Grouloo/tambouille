// The state of the Mac: what a result is tied to, and what would spoil a measure.
import { execFile } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { APP_DATA } from './config.js';

const run = promisify(execFile);
const sh = async (cmd, ...args) => {
  try {
    return (await run(cmd, args, { encoding: 'utf8', timeout: 20000 })).stdout;
  } catch (e) {
    return e.stdout ?? '';
  }
};

const getJson = async (url) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
};

export async function machineFingerprint() {
  const hw = await sh('/usr/sbin/system_profiler', 'SPHardwareDataType');
  const field = (name) => hw.match(new RegExp(`${name}: (.+)`))?.[1].trim() ?? null;
  return {
    model: field('Model Identifier'),
    chip: field('Chip'),
    memoryGb: Math.round(os.totalmem() / 1024 ** 3),
    os: (await sh('/usr/bin/sw_vers', '-productVersion')).trim(),
    bun: Bun.version,
  };
}

const onPower = async () => /AC Power/.test(await sh('/usr/bin/pmset', '-g', 'batt'));

const foreignLlama = async (own) => {
  const out = await sh('/usr/bin/pgrep', '-x', 'llama-server');
  return out.split('\n').filter(Boolean).map(Number).filter((pid) => !own.includes(pid) && pid !== process.pid);
};

/** Models loaded by anything but this campaign. */
async function loadedElsewhere(own = []) {
  const found = [];
  const lms = await getJson('http://localhost:1234/api/v0/models');
  for (const m of lms?.data ?? []) if (m.state === 'loaded') found.push({ kind: 'lmstudio', name: m.id });
  const ollama = await getJson('http://localhost:11434/api/ps');
  for (const m of ollama?.models ?? []) found.push({ kind: 'ollama', name: m.name });
  for (const pid of await foreignLlama(own)) found.push({ kind: 'llama-server', name: `pid ${pid}`, pid });
  return found;
}

/** What stands in the way of a clean measure. `own`: this campaign's engine, and its children. */
export async function machineIssues({ own = [], power = true } = {}) {
  const issues = [];
  if (power && !(await onPower())) issues.push({ kind: 'power', text: 'Le Mac n’est pas sur secteur.' });
  for (const m of await loadedElsewhere(own)) issues.push({ kind: m.kind, text: `Un modèle est chargé ailleurs (${m.kind}) : ${m.name}.`, unload: true });
  return issues;
}

/** Only on a click of the user (or `bench unload`), never by a campaign. */
export async function unloadOthers() {
  for (const m of await loadedElsewhere()) {
    if (m.kind === 'lmstudio') await sh(path.join(os.homedir(), '.lmstudio', 'bin', 'lms'), 'unload', '--all');
    if (m.kind === 'ollama') await fetch('http://localhost:11434/api/generate', { method: 'POST', body: JSON.stringify({ model: m.name, keep_alive: 0 }) }).catch(() => {});
    if (m.kind === 'llama-server') {
      const cmd = await sh('/bin/ps', '-o', 'command=', '-p', String(m.pid));
      if (cmd.includes(APP_DATA)) try { process.kill(m.pid, 'SIGTERM'); } catch {}
    }
  }
}

/** What a process holds, in MiB. Not its footprint (`top`, `footprint`): that leaves out the weights, mapped and wired for Metal. */
export const residentMb = async (pid) => {
  const kb = Number((await sh('/bin/ps', '-o', 'rss=', '-p', String(pid))).trim());
  return kb ? Math.round(kb / 1024) : null;
};

/** All the memory wired on the machine, in MiB: where Metal buffers show. */
export async function wiredMb() {
  const out = await sh('/usr/bin/vm_stat');
  const page = Number(out.match(/page size of (\d+)/)?.[1] ?? 16384);
  const pages = Number(out.match(/Pages wired down:\s+(\d+)/)?.[1]);
  return pages ? Math.round((pages * page) / 1048576) : null;
}

export async function pressure() {
  const level = Number((await sh('/usr/sbin/sysctl', '-n', 'kern.memorystatus_vm_pressure_level')).trim());
  const swap = (await sh('/usr/sbin/sysctl', '-n', 'vm.swapusage')).match(/used = ([\d.,]+)M/)?.[1];
  return { level, swapMb: swap ? Math.round(Number(swap.replace(',', '.'))) : null };
}

/** 100 unless macOS limits the CPU (a fanless Mac in a long campaign). */
export async function thermalLimit() {
  const m = (await sh('/usr/bin/pmset', '-g', 'therm')).match(/CPU_Speed_Limit\s*=\s*(\d+)/);
  return m ? Number(m[1]) : 100;
}

export const portOpen = (port, host = '127.0.0.1') => new Promise((resolve) => {
  const s = net.connect({ port, host, timeout: 1500 });
  s.on('connect', () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
  s.on('timeout', () => { s.destroy(); resolve(false); });
});

/** Keeps the Mac awake as long as this process lives. */
export const stayAwake = () => Bun.spawn(['/usr/bin/caffeinate', '-dimsu', '-w', String(process.pid)], { stdout: 'ignore', stderr: 'ignore' });

/** Peak memory of a model: the larger of what its process holds and what got wired since `wiredBefore`. */
export function sampleMemory(pid, { wiredBefore = null, everyMs = 5000 } = {}) {
  let peak = 0;
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const [resident, wired] = await Promise.all([residentMb(pid), wiredMb()]);
      peak = Math.max(peak, resident ?? 0, wiredBefore != null && wired != null ? wired - wiredBefore : 0);
      await Bun.sleep(everyMs);
    }
  })();
  return { stop: async () => { stopped = true; await Promise.race([loop, Bun.sleep(100)]); return peak || null; } };
}

/** Processes left behind by a trial, found by the temporary folder in their environment. */
export async function killStrays(marker) {
  const out = await sh('/bin/ps', '-axeww', '-o', 'pid=,command=');
  for (const line of out.split('\n')) {
    if (!line.includes(marker)) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (pid && pid !== process.pid) try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}
