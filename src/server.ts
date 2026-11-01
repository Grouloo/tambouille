// The local interface: set up a campaign, follow it, read the history, compare.
// A campaign runs in its own process, so closing the tab stops nothing. Listens on
// 127.0.0.1 only; requests that change something must come from its own page.
import fs from 'node:fs/promises';
import path from 'node:path';
import { campaignReport } from './campaign.ts';
import { DATA, PROTOCOL, ROOT } from './config.ts';
import { machineIssues, unloadOthers } from './machine.ts';
import { fitBudget, planTrials } from './plan.ts';
import { poneyModels, readSettings } from './poney.ts';
import { progressOf, transcriptFor } from './progress.ts';
import { compare } from './score.ts';
import { listCampaigns, loadCampaign, renameCampaign } from './store.ts';
import { message } from './types.ts';
import type { Measured } from './plan.ts';
import type { LiveCampaign, Tier } from './types.ts';
import { TASKS, selectTasks } from '../suite/index.ts';

export interface Selection { id?: string; name?: string; models?: string[]; categories?: string[]; ids?: string[]; budgetMinutes?: number; reference?: boolean }

const UI = path.join(import.meta.dir, 'ui');
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const TRANSPILER = new Bun.Transpiler({ loader: 'ts' });
const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function liveCampaigns() {
  const dir = path.join(DATA, 'live');
  const out: LiveCampaign[] = [];
  for (const name of await fs.readdir(dir).catch(() => [])) {
    const data = (await Bun.file(path.join(dir, name)).json().catch(() => null)) as LiveCampaign | null;
    if (data && isAlive(data.pid)) out.push(data);
  }
  return out;
}

const measuredMinutes = async (model: string): Promise<Measured> => {
  const times: Partial<Record<Tier, number[]>> = {};
  for (const c of (await listCampaigns()).slice(0, 5)) {
    for (const t of c.trials) if (t.model === model && t.durationMs) (times[t.tier] ??= []).push(t.durationMs / 60000);
  }
  return Object.fromEntries(Object.entries(times).filter(([, l]) => l.length >= 3).map(([k, l]) => [k, [...l].sort((a, b) => a - b)[Math.floor(l.length / 2)]]));
};

/** What a selection would play for each model: the same list and order as a campaign. */
async function estimate({ models = [], categories, ids, budgetMinutes = PROTOCOL.budgetMinutes }: Selection) {
  const { config } = await readSettings();
  const tasks = selectTasks({ categories, ids });
  const out = [];
  for (const id of models) {
    const plan = planTrials(tasks, { numCtx: config.numCtx, extraContexts: PROTOCOL.extraContexts });
    const measured = await measuredMinutes(id);
    const fit = fitBudget(plan, budgetMinutes, measured);
    out.push({ model: id, played: fit.fit.length, total: fit.total, counts: fit.counts, minutes: fit.minutes, complete: fit.complete, mandatoryComplete: fit.mandatoryComplete, measured: Object.keys(measured).length > 0 });
  }
  return { tasks: tasks.length, fullSuite: tasks.length === TASKS.length, models: out };
}

async function launch(args: string[]) {
  if ((await liveCampaigns()).length) throw new Error('Une campagne tourne déjà.');
  await fs.mkdir(path.join(DATA, 'logs'), { recursive: true });
  const log = path.join(DATA, 'logs', `${Date.now()}.log`);
  const p = Bun.spawn([process.execPath, 'src/cli.ts', ...args], { cwd: ROOT, stdout: Bun.file(log), stderr: Bun.file(log), stdin: 'ignore', detached: true });
  p.unref();
  return { pid: p.pid, log };
}

function startCampaign({ models, categories, ids, budgetMinutes, reference }: Selection) {
  const args = ['run', '--budget', `${budgetMinutes}m`];
  if (models?.length) args.push('--models', models.join(','));
  if (categories?.length) args.push('--categories', categories.join(','));
  if (ids?.length) args.push('--tasks', ids.join(','));
  if (reference) args.push('--reference');
  return launch(args);
}

async function overview() {
  const live = await liveCampaigns();
  const [models, issues, { config }] = await Promise.all([poneyModels(), machineIssues({ own: live.flatMap((c) => c.enginePid ?? []) }), readSettings()]);
  const tasks = TASKS.map(({ id, category, tier, lang }) => ({ id, category, tier, lang }));
  return { models, issues, live, tasks, numCtx: config.numCtx, budgetMinutes: PROTOCOL.budgetMinutes };
}

async function historyList() {
  return (await listCampaigns()).map((c) => ({ id: c.id, name: c.name, status: c.status, startedAt: c.startedAt, models: c.models.map((m) => m.id), fullSuite: c.fullSuite, trials: c.trials.length, poney: c.fingerprint.poney.commit?.slice(0, 7), machine: `${c.fingerprint.machine.chip} · ${c.fingerprint.machine.memoryGb} Go` }));
}

const knownId = (id = '') => {
  if (!/^[\w-]+$/.test(id)) throw new Error('Campagne inconnue.');
  return id;
};

const campaignId = (url: URL) => knownId(url.searchParams.get('id') ?? '');

const ROUTES: Record<string, (url: URL, body: Selection) => unknown> = {
  'GET /api/overview': () => overview(),
  'GET /api/progress': async () => Promise.all((await liveCampaigns()).map((c) => progressOf(c.id, c))),
  'GET /api/campaign': async (url) => {
    const id = campaignId(url);
    return progressOf(id, (await liveCampaigns()).find((c) => c.id === id));
  },
  'GET /api/transcript': (url) => transcriptFor(campaignId(url), url.searchParams.get('model') ?? '', url.searchParams.get('key') ?? ''),
  'GET /api/history': () => historyList(),
  'GET /api/report': (url) => campaignReport(campaignId(url)),
  'GET /api/compare': async (url) => compare(await loadCampaign(url.searchParams.get('a') ?? ''), await loadCampaign(url.searchParams.get('b') ?? '')),
  'POST /api/estimate': (_, body) => estimate(body),
  'POST /api/run': (_, body) => startCampaign(body),
  'POST /api/resume': (_, body) => {
    const id = knownId(body.id);
    return launch(['resume', id]);
  },
  'POST /api/rename': async (_, body) => {
    await renameCampaign(knownId(body.id), body.name ?? '');
    return { ok: true };
  },
  'POST /api/unload': () => unloadOthers().then(() => ({ ok: true })),
  'POST /api/stop': async () => {
    for (const c of await liveCampaigns()) process.kill(c.pid, 'SIGTERM');
    return { ok: true };
  },
};

export async function serve(port: number) {
  const origin = `http://127.0.0.1:${port}`;
  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    idleTimeout: 120,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.headers.get('origin') !== origin) return new Response('Forbidden', { status: 403 });
        const route = ROUTES[`${req.method} ${url.pathname}`];
        if (!route) return new Response('Not found', { status: 404 });
        try {
          return Response.json(await route(url, req.method === 'POST' ? ((await req.json().catch(() => ({}))) as Selection) : {}));
        } catch (e) {
          return Response.json({ error: message(e) }, { status: 500 });
        }
      }
      const name = url.pathname === '/' ? 'index.html' : path.basename(url.pathname);
      if (name === 'app.js') return new Response(TRANSPILER.transformSync(await Bun.file(path.join(UI, 'app.ts')).text()), { headers: { 'content-type': TYPES['.js'] ?? 'text/javascript' } });
      const file = Bun.file(path.join(UI, name));
      if (!(await file.exists())) return new Response('Not found', { status: 404 });
      return new Response(file, { headers: { 'content-type': TYPES[path.extname(name)] ?? 'text/plain' } });
    },
  });
  console.log(`http://127.0.0.1:${server.port}`);
  await new Promise(() => {});
}
