// What a running campaign is doing: every planned trial with its state, and the
// live activity of the current one. Reads the plan, trials.jsonl and the transcript.
import fs from 'node:fs/promises';
import { loadCampaign, transcriptPath } from './store.js';
import { TASKS } from '../suite/index.js';

const clip = (text, max) => { const s = String(text ?? '').trim(); return s.length > max ? `${s.slice(0, max)}…` : s; };

/** The last steps of a transcript, and what the model is writing right now. A line may still be incomplete. */
export function activityOf(raw, { steps: keep = 12, tail = 500 } = {}) {
  const steps = [];
  const open = new Map();
  let draft = null;
  let context = null;
  for (const line of raw.split('\n')) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'triage') steps.push({ kind: 'assessment', text: `Bilan : ${ev.route ?? '?'}, ${ev.known?.length ?? 0} connu(s), ${ev.doubts?.length ?? 0} doute(s), ${ev.unknowns?.length ?? 0} inconnu(s)` });
    else if (ev.type === 'action_start') {
      const step = { kind: 'tool', tool: ev.tool, text: clip(Object.values(ev.args ?? {}).find((v) => typeof v === 'string'), 120), ok: null };
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

const parseKey = (key) => {
  const [, task, numCtx, rep] = /^(.*)@(\d+)#(\d+)$/.exec(key) ?? [null, key, null, null];
  return { task, numCtx: Number(numCtx), rep: Number(rep) };
};

/** One planned trial per row; a trial that ran outside the plan is kept too. */
export function trialRows(keys, trials, current) {
  const byKey = new Map(trials.map((t) => [t.key, t]));
  return [...new Set([...keys, ...byKey.keys()])].map((key) => {
    const t = byKey.get(key);
    const { task, numCtx, rep } = parseKey(key);
    const known = TASKS.find((x) => x.id === task);
    return {
      key, task, numCtx, rep, category: t?.category ?? known?.category ?? '?', tier: t?.tier ?? known?.tier ?? '?',
      state: t?.outcome ?? (key === current ? 'running' : 'pending'),
      reason: t?.reason, detail: t?.detail, durationMs: t?.durationMs, judge: t?.judge?.score,
    };
  });
}

export async function progressOf(live) {
  const saved = await loadCampaign(live.id);
  const models = [];
  for (const m of saved.models) {
    const state = live.models[m.id];
    const rows = trialRows(state?.plan ?? m.planned ?? [], saved.trials.filter((t) => t.model === m.id), state?.current);
    const running = rows.find((r) => r.state === 'running');
    const raw = running ? await fs.readFile(transcriptPath(live.id, `${m.id}-${running.key}`), 'utf8').catch(() => '') : '';
    models.push({ id: m.id, phase: state?.phase ?? null, started: Boolean(state), total: state?.total || rows.length, currentSince: state?.currentSince ?? null, running: running?.key ?? null, rows, activity: running ? activityOf(raw) : null });
  }
  return { id: live.id, status: live.status, startedAt: live.startedAt, models };
}
