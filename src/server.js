// The local interface: set up a campaign, follow it, read the history, compare.
// A campaign runs in its own process, so closing the tab stops nothing. Listens on
// 127.0.0.1 only; requests that change something must come from its own page.
import fs from 'node:fs/promises';
import path from 'node:path';
import { campaignReport } from './campaign.js';
import { DATA, PROTOCOL, ROOT } from './config.js';
import { machineIssues, unloadOthers } from './machine.js';
import { fitBudget, planTrials } from './plan.js';
import { poneyModels, readSettings } from './poney.js';
import { compare } from './score.js';
import { listCampaigns, loadCampaign } from './store.js';
import { TASKS, selectTasks } from '../suite/index.js';

const UI = path.join(import.meta.dir, 'ui');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function liveCampaigns() {
  const dir = path.join(DATA, 'live');
  const out = [];
  for (const name of await fs.readdir(dir).catch(() => [])) {
    const data = await Bun.file(path.join(dir, name)).json().catch(() => null);
    if (data && isAlive(data.pid)) out.push(data);
  }
  return out;
}

const measuredMinutes = async (model) => {
  const times = {};
  for (const c of (await listCampaigns()).slice(0, 5)) {
    for (const t of c.trials) if (t.model === model && t.durationMs) (times[t.tier] ??= []).push(t.durationMs / 60000);
  }
  return Object.fromEntries(Object.entries(times).filter(([, l]) => l.length >= 3).map(([k, l]) => [k, [...l].sort((a, b) => a - b)[Math.floor(l.length / 2)]]));
};

/** What a selection would play for each model: the same list and order as a campaign. */
async function estimate({ models = [], categories, ids, budgetMinutes }) {
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

async function startCampaign({ models, categories, ids, budgetMinutes, reference }) {
  if ((await liveCampaigns()).length) throw new Error('Une campagne tourne déjà.');
  const args = ['src/cli.js', 'run', '--budget', `${budgetMinutes}m`];
  if (models?.length) args.push('--models', models.join(','));
  if (categories?.length) args.push('--categories', categories.join(','));
  if (ids?.length) args.push('--tasks', ids.join(','));
  if (reference) args.push('--reference');
  await fs.mkdir(path.join(DATA, 'logs'), { recursive: true });
  const log = path.join(DATA, 'logs', `${Date.now()}.log`);
  const p = Bun.spawn([process.execPath, ...args], { cwd: ROOT, stdout: Bun.file(log), stderr: Bun.file(log), stdin: 'ignore', detached: true });
  p.unref();
  return { pid: p.pid, log };
}

async function overview() {
  const live = await liveCampaigns();
  const [models, issues, { config }] = await Promise.all([poneyModels(), machineIssues({ own: live.map((c) => c.enginePid) }), readSettings()]);
  const tasks = TASKS.map(({ id, category, tier, lang }) => ({ id, category, tier, lang }));
  return { models, issues, live, tasks, numCtx: config.numCtx, budgetMinutes: PROTOCOL.budgetMinutes };
}

async function historyList() {
  return (await listCampaigns()).map((c) => ({ id: c.id, status: c.status, startedAt: c.startedAt, models: c.models.map((m) => m.id), fullSuite: c.fullSuite, trials: c.trials.length, poney: c.fingerprint.poney.commit?.slice(0, 7), machine: `${c.fingerprint.machine.chip} · ${c.fingerprint.machine.memoryGb} Go` }));
}

const ROUTES = {
  'GET /api/overview': () => overview(),
  'GET /api/history': () => historyList(),
  'GET /api/report': (url) => campaignReport(url.searchParams.get('id')),
  'GET /api/compare': async (url) => compare(await loadCampaign(url.searchParams.get('a')), await loadCampaign(url.searchParams.get('b'))),
  'POST /api/estimate': (_, body) => estimate(body),
  'POST /api/run': (_, body) => startCampaign(body),
  'POST /api/unload': () => unloadOthers().then(() => ({ ok: true })),
  'POST /api/stop': async () => {
    for (const c of await liveCampaigns()) process.kill(c.pid, 'SIGTERM');
    return { ok: true };
  },
};

export async function serve(port) {
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
          return Response.json(await route(url, req.method === 'POST' ? await req.json().catch(() => ({})) : null));
        } catch (e) {
          return Response.json({ error: e.message }, { status: 500 });
        }
      }
      const name = url.pathname === '/' ? 'index.html' : path.basename(url.pathname);
      const file = Bun.file(path.join(UI, name));
      if (!(await file.exists())) return new Response('Not found', { status: 404 });
      return new Response(file, { headers: { 'content-type': TYPES[path.extname(name)] ?? 'text/plain' } });
    },
  });
  console.log(`http://127.0.0.1:${server.port}`);
  await new Promise(() => {});
}
