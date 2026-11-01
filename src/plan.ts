// What a campaign plays for one model, in order. The budget cuts the end of the
// list, so what comes first is what must not be missing: the floor, then the rules.
import { EXPECTED_MINUTES, PROTOCOL } from './config.ts';
import type { Phase, PlanEntry, Task, Tier } from './types.ts';

export const trialKey = (t: Pick<PlanEntry, 'task' | 'numCtx' | 'rep'>) => `${t.task.id}@${t.numCtx}#${t.rep}`;

/**
 * `numCtx`: the main context. `extraContexts`: those this model holds, beside it.
 * Mandatory for a final verdict: the phases floor, rules, complex and repeats.
 */
export function planTrials(tasks: Task[], { numCtx, extraContexts = [], reps = PROTOCOL.simpleReps }: { numCtx: number; extraContexts?: number[]; reps?: number }): PlanEntry[] {
  const of = (tier: Tier) => tasks.filter((t) => t.tier === tier);
  const entry = (phase: Phase, mandatory: boolean) => (task: Task, rep = 1, ctx = numCtx): PlanEntry => ({ task, rep, numCtx: ctx, phase, mandatory });
  const plan = [
    ...of('simple').map((t) => entry('floor', true)(t)),
    ...of('rules').map((t) => entry('rules', true)(t)),
    ...of('complex').map((t) => entry('complex', true)(t)),
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

/** What fits in a budget, in order. The UI shows this before launching. */
export function fitBudget(plan: PlanEntry[], budgetMinutes: number, measured: Measured = {}) {
  let used = EXPECTED_MINUTES.probe;
  const fit: PlanEntry[] = [];
  for (const entry of plan) {
    used += expectedMinutes(entry, measured);
    if (used > budgetMinutes) break;
    fit.push(entry);
  }
  const counts: Partial<Record<Phase, number>> = {};
  for (const e of fit) counts[e.phase] = (counts[e.phase] ?? 0) + 1;
  return { fit, counts, total: plan.length, minutes: Math.round(used), complete: fit.length === plan.length, mandatoryComplete: plan.filter((e) => e.mandatory).length === fit.filter((e) => e.mandatory).length };
}
