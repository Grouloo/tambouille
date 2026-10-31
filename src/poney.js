// Everything that touches the Poney install. Read only: the app's settings are
// read once and copied, its engine is copied (at launch the app kills whatever
// names its own folder), its prompt cache is never used.
import fs from 'node:fs/promises';
import path from 'node:path';
import { APP_DATA, DATA, NODE, PONEY_CLI } from './config.js';

const lines = (stream) => {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let rest = '';
  return async function next() {
    for (;;) {
      const at = rest.indexOf('\n');
      if (at >= 0) {
        const line = rest.slice(0, at);
        rest = rest.slice(at + 1);
        return line;
      }
      const { value, done } = await reader.read();
      if (done) return null;
      rest += value;
    }
  };
};

async function cli(...args) {
  const p = Bun.spawn([NODE, PONEY_CLI, ...args], { env: process.env, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`poney ${args[0]}: ${err.trim() || `exit ${code}`}`);
  return out;
}

export const poneyVersion = async () => JSON.parse(await cli('version', '--json'));
export const poneyModels = async () => JSON.parse(await cli('models', '--json'));

/** The app's settings, reduced to what a run reads. Keys stay behind. */
export async function readSettings() {
  const saved = JSON.parse(await fs.readFile(path.join(APP_DATA, 'settings.json'), 'utf8'));
  const { apiKey: _, ...config } = saved.config ?? {};
  return { config, modelContexts: saved.modelContexts ?? {}, temperatureFromModel: saved.temperatureFromModel };
}

/** What a trial sees: the real settings, without Tor unless the task asks for it, and with the frozen web. */
export function trialSettings(settings, { numCtx, searxngUrl, tor }) {
  return {
    ...settings,
    modelContexts: {},
    config: { ...settings.config, numCtx, torEnabled: false, torShell: false, approval: 'auto', searxngUrl: tor ? '' : searxngUrl },
  };
}

/** The bench's own copy of the engine. */
export async function engineCopy(build) {
  const to = path.join(DATA, 'engine');
  const target = path.join(to, build);
  if (await fs.stat(target).catch(() => null)) return to;
  const from = path.join(APP_DATA, 'engine', build);
  if (!(await fs.stat(from).catch(() => null))) throw new Error(`no engine ${build} in ${from}: open a local model once in Poney to install it`);
  await fs.mkdir(to, { recursive: true });
  await fs.cp(from, target, { recursive: true, verbatimSymlinks: true });
  return to;
}

/** Loads a model and keeps it loaded across trials. `stop()` unloads it. */
export async function startEngine({ model, numCtx, cacheDir, engineDir, settingsFile, timeoutMs = 10 * 60 * 1000 }) {
  await fs.mkdir(cacheDir, { recursive: true });
  const t0 = Date.now();
  const p = Bun.spawn([NODE, PONEY_CLI, 'engine-serve', '--model', model, '--num-ctx', String(numCtx), '--cache-dir', cacheDir, '--engine-dir', engineDir, '--max-inferences', '1', '--settings', settingsFile], { stdout: 'pipe', stderr: 'pipe' });
  const errors = new Response(p.stderr).text();
  const timer = setTimeout(() => p.kill('SIGTERM'), timeoutMs);
  const first = await lines(p.stdout)();
  clearTimeout(timer);
  if (first === null) {
    await p.exited;
    throw new Error(`the engine did not start: ${(await errors).trim().slice(-400) || `exit ${p.exitCode}`}`);
  }
  const info = JSON.parse(first);
  const stop = async () => {
    p.kill('SIGTERM');
    await Promise.race([p.exited, Bun.sleep(30000)]);
    if (p.exitCode === null) p.kill('SIGKILL');
  };
  return { ...info, port: Number(new URL(info.baseUrl).port), loadMs: Date.now() - t0, stop, alive: () => p.exitCode === null };
}

/** Arguments of an agent run in a sandbox whose control folder is `ctl`. */
export function agentArgs({ model, numCtx, engineUrl, ctl, cwd, tor }) {
  return [
    NODE, PONEY_CLI, '--provider', 'poney', '--engine-url', engineUrl, '--engine-key-file', path.join(ctl, 'key'),
    '--settings', path.join(ctl, 'settings.json'), '--script', path.join(ctl, 'script.json'), '--model', model,
    '--num-ctx', String(numCtx), '--cwd', cwd, '--yes', '--json', ...(tor ? ['--tor'] : []),
  ];
}
