// A campaign: for each model a probe, then its trials, until its budget runs out.
// It stops on nothing but the user, and resumes from trials.jsonl.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA, PROTOCOL } from './config.ts';
import { startFakeWeb } from './fakeweb.ts';
import { machineFingerprint, machineIssues, pressure, sampleMemory, stayAwake, wiredMb } from './machine.ts';
import { expectedMinutes, planTrials, trialKey } from './plan.ts';
import { engineCopy, poneyModels, poneyVersion, readSettings, startEngine } from './poney.ts';
import { canary } from './sandbox.ts';
import { gradeSlop } from './slop.ts';
import { appendRecord, livePath, listCampaigns, loadCampaign, freshCampaignId, saveCampaign, saveRecords } from './store.ts';
import { replayed, runTrial } from './trial.ts';
import { message } from './types.ts';
import type { Measured } from './plan.ts';
import type { Engine } from './poney.ts';
import type { Campaign, CampaignModel, LiveCampaign, LiveModel, PoneyModel, ProbeRecord, RunRecord, SlopKind, TrialRecord } from './types.ts';
import { selectTasks, SUITE_VERSION, TASKS } from '../suite/index.ts';

const median = (l: number[]) => [...l].sort((a, b) => a - b)[Math.floor(l.length / 2)] ?? 0;
const suiteHash = () => createHash('sha256').update(TASKS.map((t) => `${t.id}:${t.version}`).join()).digest('hex').slice(0, 16);

/** sha256 of a model file, remembered by path, size and date: 17 GB take a while. */
async function modelHash(file: string): Promise<string> {
  const cacheFile = path.join(DATA, 'hashes.json');
  const cache = (await Bun.file(cacheFile).json().catch(() => ({}))) as Record<string, string>;
  const st = await fs.stat(file);
  const id = `${file}:${st.size}:${st.mtimeMs}`;
  const known = cache[id];
  if (known) return known;
  const hash = new Bun.CryptoHasher('sha256');
  for await (const chunk of Bun.file(file).stream()) hash.update(chunk);
  const digest = hash.digest('hex');
  cache[id] = digest;
  await Bun.write(cacheFile, JSON.stringify(cache, null, 2));
  return digest;
}

async function probeOne({ model, numCtx, engineDir, cacheDir, settingsFile }: { model: CampaignModel; numCtx: number; engineDir: string; cacheDir: string; settingsFile: string }): Promise<ProbeRecord> {
  const at = new Date().toISOString();
  let engine: Engine | null = null;
  const wiredBefore = await wiredMb();
  try {
    engine = await startEngine({ model: model.id, numCtx, cacheDir, engineDir, settingsFile, timeoutMs: PROTOCOL.probeMinutes * 60000 });
    const memory = sampleMemory(engine.pid, { wiredBefore, everyMs: 1000 });
    const res = await fetch(`${engine.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${engine.apiKey}` },
      body: JSON.stringify({ model: model.id, max_tokens: 200, messages: [{ role: 'user', content: 'Explain in about 100 words why the sky is blue.' }] }),
      signal: AbortSignal.timeout(PROTOCOL.probeMinutes * 60000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { timings?: { predicted_per_second?: number; prompt_ms?: number } };
    const memoryMb = await memory.stop();
    const p = await pressure();
    return { type: 'probe', at, model: model.id, numCtx, fits: p.level < 4, loadMs: engine.loadMs, tps: body.timings?.predicted_per_second ?? null, firstTokenMs: body.timings?.prompt_ms ?? null, memoryMb, estimatedMb: Math.round(engine.memory / 1048576), pressure: p };
  } catch (e) {
    return { type: 'probe', at, model: model.id, numCtx, fits: false, error: message(e).slice(0, 300) };
  } finally {
    await engine?.stop();
  }
}

/** Options of `bench run`, turned into what is recorded before anything starts. */
export async function prepare({ models, budgetMinutes = PROTOCOL.budgetMinutes, categories, ids, reference = false }: { models?: string[]; budgetMinutes?: number; categories?: string[]; ids?: string[]; reference?: boolean }): Promise<Campaign> {
  const [poney, machine, installed, settings] = await Promise.all([poneyVersion(), machineFingerprint(), poneyModels(), readSettings()]);
  const chosen = installed.filter((m) => !models?.length || models.includes(m.id));
  if (!chosen.length) throw new Error(`aucun modèle : ${models?.join(', ') || 'rien d’installé'}`);
  if (models?.length && chosen.length < models.length) throw new Error(`modèle inconnu parmi : ${models.join(', ')}`);
  const chosenList: PoneyModel[] = chosen;
  if (reference) {
    const past = (await listCampaigns()).find((c) => c.fingerprint.machine.chip === machine.chip);
    const ref = [...installed].sort((a, b) => a.size - b.size).find((m) => m.id.startsWith(PROTOCOL.referenceModel ?? ''));
    if (past && past.fingerprint.poney.commit !== poney.commit && ref && !chosenList.includes(ref)) chosenList.push(ref);
  }
  const tasks = selectTasks({ categories, ids });
  if (!tasks.length) throw new Error('aucune tâche sélectionnée');
  const list: CampaignModel[] = [];
  for (const m of chosenList) list.push({ ...m, sha256: await modelHash(m.file ?? '') });
  return {
    id: await freshCampaignId(),
    status: 'running',
    startedAt: new Date().toISOString(),
    budgetMinutes,
    selection: { categories: categories ?? null, ids: ids ?? null },
    fullSuite: tasks.length === TASKS.length,
    taskIds: tasks.map((t) => t.id),
    models: list,
    fingerprint: {
      machine,
      poney,
      suite: { ...SUITE_VERSION, hash: suiteHash() },
      settings: createHash('sha256').update(JSON.stringify(settings)).digest('hex').slice(0, 16),
      judge: PROTOCOL.judgeModel,
    },
  };
}

export async function runCampaign(campaign: Campaign, { log = console.log, signal }: { log?: (line: string) => void; signal?: AbortSignal } = {}) {
  const sandboxCheck = await canary();
  if (!sandboxCheck.ok) throw new Error(`le bac à sable ne tient pas : ${sandboxCheck.checks.filter((c) => !c.ok).map((c) => c.name).join(', ')}`);
  const issues = await machineIssues();
  if (issues.length) throw new Error(`machine occupée : ${issues.map((i) => i.text).join(' ')}`);

  // (results keep no paths: a resumed campaign finds its files again)
  const installed = await poneyModels();
  for (const m of campaign.models) {
    const found = installed.find((x) => x.id === m.id);
    if (!found) throw new Error(`modèle introuvable : ${m.id}`);
    m.file = found.file;
  }
  const previous = await loadCampaign(campaign.id).catch(() => null);
  const records: RunRecord[] = [...(previous?.probes ?? []), ...(previous?.trials ?? [])];
  campaign.status = 'running';
  delete campaign.stopReason;
  await saveCampaign(campaign);
  const settings = await readSettings();
  const engineDir = await engineCopy(campaign.fingerprint.poney.engineBuild);
  const tasks = selectTasks(campaign.selection).filter((t) => campaign.taskIds.includes(t.id));
  const mainCtx = settings.config.numCtx;
  const work = path.join(DATA, 'run', campaign.id);
  const settingsFile = path.join(work, 'settings.json');
  await Bun.write(settingsFile, JSON.stringify(settings));
  const awake = stayAwake();
  const web = await startFakeWeb();
  const live: LiveCampaign = { id: campaign.id, pid: process.pid, status: 'running', startedAt: campaign.startedAt, models: {} };
  const publish = () => Bun.write(livePath(campaign.id), JSON.stringify(live));
  const record = async (r: RunRecord) => {
    records.push(r);
    await appendRecord(campaign.id, r);
  };

  const brokenTasks = new Set<string>();
  try {
    for (const [index, model] of campaign.models.entries()) {
      if (signal?.aborted) break;
      if (index) await Bun.sleep(signal?.aborted ? 0 : PROTOCOL.pauseBetweenModelsSeconds * 1000);
      const started = Date.now();
      const deadline = started + campaign.budgetMinutes * 60000;
      const state: LiveModel = (live.models[model.id] = { phase: 'probe', done: 0, total: 0, current: null });
      await publish();

      // The probe: what holds, at what speed.
      const contexts = [...new Set([...PROTOCOL.extraContexts, mainCtx])].sort((a, b) => a - b);
      for (const numCtx of contexts) {
        if (records.some((r) => r.type === 'probe' && r.model === model.id && r.numCtx === numCtx)) continue;
        log(`[${model.id}] sonde ${numCtx}`);
        await record(await probeOne({ model, numCtx, engineDir, cacheDir: path.join(work, 'probe-cache'), settingsFile }));
      }
      const fits = (n: number) => records.some((r) => r.type === 'probe' && r.model === model.id && r.numCtx === n && r.fits);
      const usable = contexts.filter(fits);
      const primaryCtx = fits(mainCtx) ? mainCtx : usable.filter((n) => n < mainCtx).at(-1);
      model.mainCtx = primaryCtx ?? null;
      model.reducedContext = primaryCtx !== mainCtx;
      if (!primaryCtx) {
        log(`[${model.id}] ne tient à aucune taille de contexte`);
        continue;
      }

      const plan = planTrials(tasks, { numCtx: primaryCtx, extraContexts: usable.filter((n) => n !== primaryCtx) });
      model.planned = plan.filter((e) => e.mandatory).map(trialKey);
      await saveCampaign(campaign);
      const trialsOf = () => records.filter((r): r is TrialRecord => r.type === 'trial' && r.model === model.id);
      const done = new Set(trialsOf().filter((r) => r.outcome !== 'infra').map((r) => r.key));
      state.total = plan.length;
      state.plan = plan.map(trialKey);
      state.done = plan.filter((e) => done.has(trialKey(e))).length;

      let engine: Engine | null = null;
      const cacheDir = path.join(work, 'cache', model.sha256.slice(0, 12));
      const measured: Measured = {};
      try {
        for (const entry of plan) {
          if (signal?.aborted) break;
          const key = trialKey(entry);
          if (done.has(key)) continue;
          const left = (deadline - Date.now()) / 60000;
          if (left < expectedMinutes(entry, measured)) continue; // (a shorter one may still fit)
          for (let attempt = 0; attempt < 2 && !signal?.aborted;) {
            if (!engine || !engine.alive() || engine.numCtx !== entry.numCtx) {
              await engine?.stop();
              state.phase = 'chargement';
              await publish();
              const wiredBefore = await wiredMb();
              engine = await startEngine({ model: model.id, numCtx: entry.numCtx, cacheDir, engineDir, settingsFile });
              engine.wiredBefore = wiredBefore;
              live.enginePid = engine.pid;
            }
            // Something else took the machine: wait, and do not trust what ran meanwhile.
            const own = [engine.pid];
            for (let busy = await machineIssues({ own }); busy.length && !signal?.aborted; busy = await machineIssues({ own })) {
              live.status = `pause : ${busy[0].text}`;
              await publish();
              await Bun.sleep(30000);
            }
            live.status = 'running';
            state.phase = entry.phase;
            state.current = key;
            state.currentSince = Date.now();
            await publish();
            log(`[${model.id}] ${key}`);
            const r = await runTrial({ campaign: campaign.id, entry, model, engine, web, settings, primary: entry.numCtx === primaryCtx, signal, pendingDir: path.join(DATA, 'pending', campaign.id) });
            if (r.outcome === 'invalid') break;
            if ((await machineIssues({ own, power: false })).length) continue; // (played again, it does not count)
            if (replayed(r.outcome) && attempt === 0) {
              attempt++;
              log(`[${model.id}] ${key} : panne, rejouée (${r.reason})`);
              continue;
            }
            await record(r);
            log(`[${model.id}] ${key} → ${r.outcome}${r.reason ? ` (${r.reason})` : ''}`);
            if (r.outcome === 'infra') brokenTasks.add(entry.task.id);
            else brokenTasks.clear();
            if (brokenTasks.size >= PROTOCOL.maxBrokenTasks) throw new Error(`${brokenTasks.size} tâches en panne de suite : ${r.reason?.trim().slice(0, 200)}`);
            done.add(key);
            state.done++;
            const times = trialsOf().filter((x) => x.tier === entry.task.tier && x.durationMs).map((x) => (x.durationMs ?? 0) / 60000);
            if (times.length >= 3) measured[entry.task.tier] = median(times);
            await publish();
            break;
          }
        }
        if (!signal?.aborted && state.done < plan.length) log(`[${model.id}] budget épuisé : ${plan.length - state.done} essais non joués`);
      } finally {
        await engine?.stop();
      }
    }
  } catch (e) {
    campaign.stopReason = message(e); // (not finished: it can be resumed)
    throw e;
  } finally {
    web.stop();
    awake.kill();
    await fs.rm(path.join(work, 'probe-cache'), { recursive: true, force: true });
    await fs.rm(path.join(work, 'cache'), { recursive: true, force: true });
    campaign.status = signal?.aborted || campaign.stopReason ? 'stopped' : 'finished';
    campaign.finishedAt = new Date().toISOString();
    await saveCampaign(campaign);
    await fs.rm(livePath(campaign.id), { force: true });
  }
  return campaign;
}

/** Judges what the judge could not reach during the campaign. */
export async function rejudge(id: string, { log = console.log }: { log?: (line: string) => void } = {}) {
  const { judge } = await import('./judge.ts');
  const campaign = await loadCampaign(id);
  const pending = path.join(DATA, 'pending', id);
  let changed = 0;
  for (const t of campaign.trials.filter((x) => x.outcome === 'unjudged')) {
    const file = path.join(pending, `${t.key.replace(/[^\w.@#-]+/g, '_')}.json`);
    const data = (await Bun.file(file).json().catch(() => null)) as { prompt: string; answer: string } | null;
    const task = TASKS.find((x) => x.id === t.task);
    if (!data || !task?.judge) continue;
    const v = await judge({ ...data, rubric: task.judge.rubric });
    t.judge = { model: v.model, score: v.score, level: v.level ?? null, reasons: v.reasons };
    if (task.judge.censorship) {
      t.censorship = v.level === 'refused' || v.score === 0 ? 'refused' : v.level === 'partial' || v.score < 1 ? 'partial' : 'answered';
      t.outcome = t.censorship === 'answered' ? 'pass' : 'fail';
    } else t.outcome = v.score < (task.judge.threshold ?? 0) ? 'fail' : 'pass';
    delete t.reason;
    await fs.rm(file, { force: true });
    changed++;
  }
  for (const t of campaign.trials.filter((x) => x.slopPending)) {
    const file = path.join(pending, `${t.key.replace(/[^\w.@#-]+/g, '_')}.slop.json`);
    const data = (await Bun.file(file).json().catch(() => null)) as { prompt: string; kind: SlopKind; text: string } | null;
    if (!data) continue;
    t.slop = await gradeSlop(data);
    delete t.slopPending;
    await fs.rm(file, { force: true });
    changed++;
  }
  await saveRecords(id, [...campaign.probes, ...campaign.trials]);
  log(`${changed} essais jugés`);
}

/** The ranking of a campaign, as the UI and `bench report` show it. */
export async function campaignReport(id: string) {
  const { evaluation, rank } = await import('./score.ts');
  const campaign = await loadCampaign(id);
  return { campaign, ranking: rank(campaign.models.map((m) => evaluation(campaign, m))) };
}

