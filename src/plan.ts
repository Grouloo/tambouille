// What a campaign plays for one model, in order. The budget cuts the end of the
// list, so the start of it must already be a fair sample: the floor, the rules and
// the complex tasks share the time, and each goes through the categories in turn.
import { EXPECTED_MINUTES, PROTOCOL } from './config.ts';
import type { Phase, PlanEntry, Task, Tier } from './types.ts';

export const trialKey = (t: Pick<PlanEntry, 'task' | 'numCtx' | 'rep'>) => `${t.task.id}@${t.numCtx}#${t.rep}`;

/** Of the time, as long as all three have something left to play. */
const SHARES = { floor: 0.4, rules: 0.2, complex: 0.4 };

/** The first task of each category, then the second of each, and so on. */
const acrossCategories = (tasks: Task[]) => {
  const seen: Record<string, number> = {};
  return tasks.map((task) => {
    seen[task.category] = (seen[task.category] ?? 0) + 1;
    return { task, turn: seen[task.category] ?? 0 };
  }).sort((a, b) => a.turn - b.turn).map(({ task }) => task);
};

/** Always takes from the stream furthest behind its share of the time. */
function shareTime(streams: { share: number; entries: PlanEntry[] }[]) {
  const out: PlanEntry[] = [];
  const queues = streams.map((s) => ({ ...s, left: [...s.entries], used: 0 }));
  for (;;) {
    const open = queues.filter((q) => q.left.length);
    const next = open.reduce<typeof open[number] | null>((best, q) => (!best || q.used / q.share < best.used / best.share ? q : best), null);
    const entry = next?.left.shift();
    if (!next || !entry) return out;
    next.used += expectedMinutes(entry);
    out.push(entry);
  }
}

/**
 * `numCtx`: the main context. `extraContexts`: those this model holds, beside it.
 * Mandatory for a final verdict: the phases floor, rules, complex and repeats.
 */
export function planTrials(tasks: Task[], { numCtx, extraContexts = [], reps = PROTOCOL.simpleReps }: { numCtx: number; extraContexts?: number[]; reps?: number }): PlanEntry[] {
  const of = (tier: Tier) => tasks.filter((t) => t.tier === tier);
  const entry = (phase: Phase, mandatory: boolean) => (task: Task, rep = 1, ctx = numCtx): PlanEntry => ({ task, rep, numCtx: ctx, phase, mandatory });
  const plan = [
    ...shareTime([
      { share: SHARES.floor, entries: acrossCategories(of('simple')).map((t) => entry('floor', true)(t)) },
      { share: SHARES.rules, entries: of('rules').map((t) => entry('rules', true)(t)) },
      { share: SHARES.complex, entries: acrossCategories(of('complex')).map((t) => entry('complex', true)(t)) },
    ]),
    ...of('censorship').map((t) => entry('censorship', false)(t)),
  ];
  for (let rep = 2; rep <= reps; rep++) plan.push(...of('simple').map((t) => entry('repeats', true)(t, rep)));
  for (const ctx of extraContexts) {
    plan.push(...tasks.filter((t) => t.category === 'harness' && (t.tier === 'simple' || t.tier === 'complex')).map((t) => entry('contexts', false)(t, 1, ctx)));
  }
  return plan;
}

/** Minutes expected for a trial: what this model took on this tier, or the default. */
export type Measured = Partial<Record<Tier, number>>;

export const expectedMinutes = (entry: PlanEntry, measured: Measured = {}) => measured[entry.task.tier] ?? entry.task.expectedMinutes ?? EXPECTED_MINUTES[entry.task.tier];

/** What fits in a budget, in order: a long trial that no longer fits leaves its place to a shorter one. The UI shows this before launching. */
export function fitBudget(plan: PlanEntry[], budgetMinutes: number, measured: Measured = {}) {
  let used = EXPECTED_MINUTES.probe;
  const fit: PlanEntry[] = [];
  for (const entry of plan) {
    if (used + expectedMinutes(entry, measured) > budgetMinutes) continue;
    used += expectedMinutes(entry, measured);
    fit.push(entry);
  }
  const counts: Partial<Record<Phase, number>> = {};
  for (const e of fit) counts[e.phase] = (counts[e.phase] ?? 0) + 1;
  return { fit, counts, total: plan.length, minutes: Math.round(used), complete: fit.length === plan.length, mandatoryComplete: plan.filter((e) => e.mandatory).length === fit.filter((e) => e.mandatory).length };
}
