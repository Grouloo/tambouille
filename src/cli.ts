#!/usr/bin/env bun
// bun src/cli.js <command>. See README.md.
import { campaignReport, prepare, rejudge, runCampaign } from './campaign.ts';
import { PROTOCOL } from './config.ts';
import { machineIssues, unloadOthers } from './machine.ts';
import { planTrials, fitBudget } from './plan.ts';
import { poneyModels } from './poney.ts';
import { canary } from './sandbox.ts';
import { compare } from './score.ts';
import { listCampaigns, loadCampaign } from './store.ts';
import { message } from './types.ts';
import type { Campaign, LoadedCampaign } from './types.ts';
import { selectTasks } from '../suite/index.ts';

const argv = process.argv.slice(2);
const command = argv.shift();
const opts: Record<string, string | true> = {};
const words: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const word = argv[i] ?? '';
  if (!word.startsWith('--')) { words.push(word); continue; }
  const key = word.slice(2);
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) opts[key] = true;
  else { opts[key] = value; i++; }
}
const list = (v?: string | true) => (typeof v === 'string' ? v.split(',').filter(Boolean) : undefined);
const minutes = (v?: string | true) => {
  if (v === undefined) return undefined;
  const m = String(v).match(/^(?:(\d+)h)?(?:(\d+)m?)?$/);
  if (!m || (!m[1] && !m[2])) throw new Error(`--budget : ${v} (ex. 90m, 1h, 2h30)`);
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
};
const percent = (x: number | null | undefined) => (x == null ? '—' : `${Math.round(x * 100)} %`);

const needed = (id?: string) => {
  if (!id) throw new Error('il manque un identifiant de campagne');
  return id;
};

function usage() {
  console.log(`Usage: bun src/cli.js <command>
  models                     the models Poney can run
  preflight                  sandbox canary and state of the machine
  unload                     unloads the models held by other apps
  plan [selection]           what a budget would play, without running
  run [selection]            starts a campaign
  resume ID                  goes on with an interrupted campaign
  rejudge ID                 judges what the judge could not reach
  report [ID]                the ranking of a campaign (default: the latest)
  compare ID_A ID_B          two campaigns, on their common tasks
  serve [--port 4177]        the local interface

Selection: --models a,b  --categories code,terminal  --tasks id,id  --budget 1h30  --reference`);
}

async function report(id?: string) {
  const target = id ?? (await listCampaigns())[0]?.id;
  if (!target) return console.log('Aucune campagne.');
  const { campaign, ranking } = await campaignReport(target);
  console.log(`${campaign.id}  ${campaign.status}  Poney ${campaign.fingerprint.poney.commit?.slice(0, 7)}  ${campaign.fingerprint.machine.chip} ${campaign.fingerprint.machine.memoryGb} Go\n`);
  for (const [i, m] of ranking.entries()) {
    const s = m.summary;
    console.log(`${i + 1}. ${m.model} @${m.mainCtx ?? '—'}  ${s.verdict}${s.missing ? ` (${s.missing} essais manquants)` : ''}`);
    console.log(`   simples ${percent(s.simpleRate)}  complexes ${percent(s.complexRate)}  outils mal utilisés ${percent(s.tools.misuseRate)}  refus ${percent(s.censorship.refusalRate)}`);
    console.log(`   temps médian ${s.speed.medianSimpleMs ? `${Math.round(s.speed.medianSimpleMs / 1000)} s` : '—'}  ${s.speed.tps ?? '—'} t/s  mémoire ${s.memoryPeakMb ? `${(s.memoryPeakMb / 1024).toFixed(1)} Go` : '—'}`);
    const c = s.metacognition;
    console.log(`   bilan : ${c.overconfident} sûr à tort, ${c.underconfident + c.blind} doute à tort, ${c.unreadable} illisibles ; réussite ${percent(c.directSuccess)} si direct, ${percent(c.lookupSuccess)} si vérifié`);
    for (const r of s.reasons) console.log(`   ✗ ${r}`);
  }
}

try {
  switch (command) {
    case 'models':
      for (const m of await poneyModels()) console.log(`${m.id}\t${(m.size / 1024 ** 3).toFixed(1)} Go`);
      break;
    case 'preflight': {
      const c = await canary();
      for (const r of c.checks) console.log(`${r.ok ? '✓' : '✗'} ${r.wanted === 'works' ? 'can' : 'cannot'}: ${r.name}${r.ok ? '' : `  ${r.detail}`}`);
      const issues = await machineIssues();
      for (const i of issues) console.log(`! ${i.text}`);
      if (!c.ok || issues.length) process.exitCode = 1;
      break;
    }
    case 'unload':
      await unloadOthers();
      break;
    case 'plan': {
      const tasks = selectTasks({ categories: list(opts.categories), ids: list(opts.tasks) });
      const budget = minutes(opts.budget) ?? PROTOCOL.budgetMinutes;
      const r = fitBudget(planTrials(tasks, { numCtx: 32000, extraContexts: PROTOCOL.extraContexts }), budget);
      console.log(`${tasks.length} tâches, ${r.fit.length}/${r.total} essais en ${budget} min par modèle`, r.counts, r.mandatoryComplete ? 'verdict définitif possible' : 'verdict provisoire');
      break;
    }
    case 'run': {
      const campaign = await prepare({ models: list(opts.models), budgetMinutes: minutes(opts.budget), categories: list(opts.categories), ids: list(opts.tasks), reference: Boolean(opts.reference) });
      await execute(campaign);
      break;
    }
    case 'resume':
      await execute(await loadCampaign(needed(words[0])));
      break;
    case 'rejudge':
      await rejudge(needed(words[0]));
      break;
    case 'report':
      await report(words[0]);
      break;
    case 'compare': {
      const c = compare(await loadCampaign(needed(words[0])), await loadCampaign(needed(words[1])));
      console.log(c);
      break;
    }
    case 'serve': {
      const { serve } = await import('./server.ts');
      await serve(Number(opts.port) || 4177);
      break;
    }
    default:
      usage();
      if (command) process.exitCode = 1;
  }
} catch (e) {
  console.error(`Erreur : ${message(e)}`);
  process.exitCode = 1;
}

async function execute(campaign: Campaign | LoadedCampaign) {
  const { trials: _, probes: __, ...saved } = campaign as LoadedCampaign;
  const stop = new AbortController();
  process.on('SIGTERM', () => stop.abort());
  process.on('SIGINT', () => stop.abort());
  await runCampaign(saved, { signal: stop.signal });
  await report(campaign.id);
}

