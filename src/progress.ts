// What a running campaign is doing: every planned trial with its state, and the
// live activity of the current one. Reads the plan, trials.jsonl and the transcript.
import fs from 'node:fs/promises';
import { loadCampaign, transcriptPath } from './store.ts';
import type { AgentEvent, AssessmentPoint, LiveCampaign, TrialRecord } from './types.ts';
import { TASKS } from '../suite/index.ts';

export interface Step { kind: string; text: string; tool?: string; ok?: boolean | null }
export interface ToolEntry { kind: 'tool'; tool: string; args: Record<string, unknown>; ok: boolean | null; output: string | null }
export type TranscriptEntry = ToolEntry
  | { kind: 'assessment'; route?: string; known: AssessmentPoint[]; doubts: AssessmentPoint[]; unknowns: AssessmentPoint[] }
  | { kind: 'notice' | 'thinking' | 'answer' | 'draft'; text: string };
export type Progress = Awaited<ReturnType<typeof progressOf>>;
export type ProgressModel = Progress['models'][number];
export type TrialRow = ReturnType<typeof trialRows>[number];

const parseEvent = (line: string): AgentEvent | null => {
  try {
    return JSON.parse(line) as AgentEvent;
  } catch {
    return null;
  }
};
const clip = (text: unknown, max: number) => { const s = String(text ?? '').trim(); return s.length > max ? `${s.slice(0, max)}…` : s; };

/** The last steps of a transcript, and what the model is writing right now. A line may still be incomplete. */
export function activityOf(raw: string, { steps: keep = 12, tail = 500 }: { steps?: number; tail?: number } = {}) {
  const steps: Step[] = [];
  const open = new Map<AgentEvent['id'], Step>();
  let draft = null as { kind: string; text: string } | null;
  let context = null as { used?: number; numCtx?: number } | null;
  for (const line of raw.split('\n')) {
    const ev = parseEvent(line);
    if (!ev) continue;
    if (ev.type === 'triage') steps.push({ kind: 'assessment', text: `Bilan : ${ev.route ?? '?'}, ${ev.known?.length ?? 0} connu(s), ${ev.doubts?.length ?? 0} doute(s), ${ev.unknowns?.length ?? 0} inconnu(s)` });
    else if (ev.type === 'action_start') {
      const step: Step = { kind: 'tool', tool: ev.tool, text: clip(Object.values(ev.args ?? {}).find((v) => typeof v === 'string'), 120), ok: null };
      open.set(ev.id, step);
      steps.push(step);
    } else if (ev.type === 'action_end') {
      const step = open.get(ev.id);
      if (step) step.ok = ev.ok !== false;
    } else if (ev.type === 'notice' && ev.text) steps.push({ kind: 'notice', text: clip(ev.text, 200) });
    else if (ev.type === 'compaction') steps.push({ kind: 'notice', text: 'Contexte compacté' });
    else if (ev.type === 'context') context = { used: ev.used, numCtx: ev.numCtx };
    else if (ev.type === 'assistant_start') draft = { kind: 'text', text: '' };
    else if (ev.type === 'delta' && draft) {
      draft.kind = ev.kind === 'thinking' ? 'thinking' : 'text';
      draft.text = (draft.text + (ev.text ?? '')).slice(-tail);
    } else if (ev.type === 'assistant_end') {
      draft = null;
      if (ev.text) steps.push({ kind: 'answer', text: clip(ev.text, 300) });
    }
  }
  return { steps: steps.slice(-keep), draft: draft?.text ? draft : null, context };
}

const parseKey = (key: string) => {
  const [, task, numCtx, rep] = /^(.*)@(\d+)#(\d+)$/.exec(key) ?? [null, key, null, null];
  return { task, numCtx: Number(numCtx), rep: Number(rep) };
};

/** One planned trial per row; a trial that ran outside the plan is kept too. */
export function trialRows(keys: string[], trials: Pick<TrialRecord, 'key' | 'outcome' | 'reason' | 'detail' | 'durationMs' | 'category' | 'tier' | 'judge' | 'slop'>[], current?: string | null) {
  const byKey = new Map(trials.map((t) => [t.key, t]));
  return [...new Set([...keys, ...byKey.keys()])].map((key) => {
    const t = byKey.get(key);
    const { task, numCtx, rep } = parseKey(key);
    const known = TASKS.find((x) => x.id === task);
    return {
      key, task, numCtx, rep, category: t?.category ?? known?.category ?? '?', tier: t?.tier ?? known?.tier ?? '?',
      state: t?.outcome ?? (key === current ? 'running' : 'pending'),
      reason: t?.reason, detail: t?.detail, durationMs: t?.durationMs, judge: t?.judge?.score, slop: t?.slop?.score,
    };
  });
}

/** A whole transcript, readable: the deltas are dropped, what they built is in assistant_end. */
export function transcriptOf(raw: string, { output = 4000 }: { output?: number } = {}) {
  const entries: TranscriptEntry[] = [];
  const open = new Map<AgentEvent['id'], ToolEntry>();
  let draft = '';
  for (const line of raw.split('\n')) {
    const ev = parseEvent(line);
    if (!ev) continue;
    if (ev.type === 'triage') entries.push({ kind: 'assessment', route: ev.route, known: ev.known ?? [], doubts: ev.doubts ?? [], unknowns: ev.unknowns ?? [] });
    else if (ev.type === 'action_start') {
      const entry: ToolEntry = { kind: 'tool', tool: ev.tool ?? '', args: ev.args ?? {}, ok: null, output: null };
      open.set(ev.id, entry);
      entries.push(entry);
    } else if (ev.type === 'action_end') {
      const entry = open.get(ev.id);
      if (entry) Object.assign(entry, { ok: ev.ok !== false, output: clip(ev.output, output) });
    } else if (ev.type === 'notice' && ev.text) entries.push({ kind: 'notice', text: ev.text });
    else if (ev.type === 'compaction') entries.push({ kind: 'notice', text: 'Contexte compacté' });
    else if (ev.type === 'assistant_start') draft = '';
    else if (ev.type === 'delta') draft += ev.text ?? '';
    else if (ev.type === 'assistant_end') {
      draft = '';
      if (ev.thinking) entries.push({ kind: 'thinking', text: ev.thinking });
      if (ev.text) entries.push({ kind: 'answer', text: ev.text });
    }
  }
  if (draft) entries.push({ kind: 'draft', text: draft });
  return entries;
}

/** Waiting, running or done, and what is left: the mean of the trials played so far, within the budget. */
export function modelState({ started, index, lastStarted, rows, total, budgetMinutes, live, finished }: { started: boolean; index: number; lastStarted: number; rows: { state: string; durationMs?: number }[]; total: number; budgetMinutes: number; live: boolean; finished?: boolean }) {
  const played = rows.filter((r) => r.state !== 'pending' && r.state !== 'running');
  const left = Math.max(total - played.length, 0);
  let state: 'waiting' | 'running' | 'done' | 'interrupted';
  if (live) state = !started ? 'waiting' : left === 0 || index < lastStarted ? 'done' : 'running';
  else state = finished || left === 0 ? 'done' : 'interrupted';
  if (state !== 'running' && state !== 'waiting') return { state, remainingMs: null };
  const spent = played.reduce((sum, r) => sum + (r.durationMs ?? 0), 0);
  const budget = budgetMinutes * 60000;
  if (state === 'waiting' || !played.length) return { state, remainingMs: budget };
  return { state, remainingMs: Math.max(Math.min((spent / played.length) * left, budget - spent), 0) };
}

export async function progressOf(id: string, live: LiveCampaign | null = null) {
  const saved = await loadCampaign(id);
  const lastStarted = Math.max(...saved.models.map((m, i) => (live?.models[m.id] ? i : -1)));
  const models = [];
  for (const [index, m] of saved.models.entries()) {
    const state = live?.models[m.id];
    const rows = trialRows(state?.plan ?? m.planned ?? [], saved.trials.filter((t) => t.model === m.id), live ? state?.current : null);
    const running = rows.find((r) => r.state === 'running');
    const raw = running ? await fs.readFile(transcriptPath(id, `${m.id}-${running.key}`), 'utf8').catch(() => '') : '';
    const total = state?.total || rows.length;
    const evaluation = modelState({ started: Boolean(state), index, lastStarted, rows, total, budgetMinutes: saved.budgetMinutes, live: Boolean(live), finished: saved.status === 'finished' });
    models.push({ id: m.id, phase: state?.phase ?? null, ...evaluation, total, currentSince: state?.currentSince ?? null, running: running?.key ?? null, rows, activity: running ? activityOf(raw) : null });
  }
  const f = saved.fingerprint;
  return {
    id, name: saved.name, live: Boolean(live), status: live?.status ?? saved.status, startedAt: saved.startedAt, finishedAt: saved.finishedAt, budgetMinutes: saved.budgetMinutes, fullSuite: saved.fullSuite,
    machine: `${f.machine.chip}, ${f.machine.memoryGb} Go`, poney: f.poney.commit?.slice(0, 7), suite: f.suite.label, models,
  };
}

/** The transcript of a trial of this campaign. Only ids the campaign knows reach the disk. */
export async function transcriptFor(id: string, model: string, key: string) {
  const saved = await loadCampaign(id);
  if (!saved.models.some((m) => m.id === model)) throw new Error('Modèle inconnu.');
  return { entries: transcriptOf(await fs.readFile(transcriptPath(id, `${model}-${key}`), 'utf8').catch(() => '')) };
}
