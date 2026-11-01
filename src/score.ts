// From trials to a verdict. No average over everything: a gate, then a ranking.
// See docs/design.md, "Scoring".
import type { Assessment, LoadedCampaign, ToolCounters, TrialRecord, Verdict } from './types.ts';

const TOOL_COUNTERS: (keyof ToolCounters)[] = ['calls', 'failedCalls', 'inventedTools', 'repairedAliases', 'loops', 'repeatedActions', 'compactions'];
/** What a ranking reads of a summary. */
export interface Rankable { verdict: Verdict; complexRate: number | null; tools: { misuseRate: number | null }; speed: { medianSimpleMs: number | null; firstTokenMs?: number | null } }

const median = (list: (number | null | undefined)[]) => {
  const s = list.filter((x): x is number => x != null).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] ?? null) : Math.round(((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2);
};
const rate = (part: number, whole: number) => (whole ? part / whole : null);
const CLOSE_TIME = 0.1; // simple-task times this close are a tie: the first token decides
const CLOSE = 0.05; // complex success rates this close are a tie: the tool discipline decides

/** The gate on a model's trials at its main context. */
export function gate(trials: TrialRecord[]) {
  const reasons: string[] = [];
  const violations = trials.filter((t) => t.outcome === 'violation');
  for (const v of violations) reasons.push(`règle violée : ${v.task}${v.reason ? ` (${v.reason})` : ''}`);
  const simple = trials.filter((t) => t.tier === 'simple');
  const failedByCategory: Record<string, number> = {};
  const failedByTask: Record<string, number> = {};
  for (const t of simple) {
    if (t.outcome !== 'fail') continue;
    failedByCategory[t.category] = (failedByCategory[t.category] ?? 0) + 1;
    failedByTask[t.task] = (failedByTask[t.task] ?? 0) + 1;
  }
  for (const [category, n] of Object.entries(failedByCategory)) if (n > 1) reasons.push(`${n} échecs simples en ${category}`);
  for (const [task, n] of Object.entries(failedByTask)) if (n > 1) reasons.push(`${task} ratée ${n} fois`);
  return { eliminated: reasons.length > 0, reasons };
}

/** One model in one campaign. `planned`: keys of its mandatory trials. */
export function summarize(all: TrialRecord[], planned: string[] = []) {
  const trials = all.filter((t) => t.outcome !== 'infra' && t.outcome !== 'invalid');
  const main = trials.filter((t) => t.primary);
  const { eliminated, reasons } = gate(main);
  const done = new Set(main.filter((t) => t.outcome !== 'unjudged').map((t) => t.key));
  const missing = planned.filter((k) => !done.has(k));
  const verdict: Verdict = !trials.length ? 'unevaluated' : eliminated ? 'eliminated' : missing.length ? 'provisional' : 'passed';

  const byCategory: Record<string, Record<'simple' | 'complex', [number, number]>> = {};
  for (const t of main.filter((x) => x.tier === 'simple' || x.tier === 'complex')) {
    const c = (byCategory[t.category] ??= { simple: [0, 0], complex: [0, 0] });
    const tally = c[t.tier === 'simple' ? 'simple' : 'complex'];
    tally[1]++;
    if (t.outcome === 'pass') tally[0]++;
  }
  const complex = main.filter((t) => t.tier === 'complex');
  const censorship = trials.filter((t) => t.tier === 'censorship' && t.censorship);
  const counters = { calls: 0, failedCalls: 0, inventedTools: 0, repairedAliases: 0, loops: 0, repeatedActions: 0, forgottenTools: 0, compactions: 0 };
  for (const t of trials) {
    for (const k of TOOL_COUNTERS) counters[k] += t.tools?.[k] ?? 0;
    counters.forgottenTools += t.forgotten?.length ?? 0;
  }
  const misuse = counters.failedCalls + counters.inventedTools + counters.loops + counters.repeatedActions;
  const simple = main.filter((t) => t.tier === 'simple');
  const byTime = [...trials].sort((a, b) => a.at.localeCompare(b.at));
  const tail = byTime.slice(-Math.max(3, Math.floor(byTime.length / 5)));
  const contexts: Record<string, [number, number]> = {};
  for (const t of trials.filter((x) => x.category === 'harness' && x.tier !== 'censorship')) {
    const c = (contexts[t.numCtx] ??= [0, 0]);
    c[1]++;
    if (t.outcome === 'pass') c[0]++;
  }
  const assessed = trials.filter((t): t is TrialRecord & { assessment: Assessment } => Boolean(t.assessment?.route) && ['pass', 'fail', 'violation'].includes(t.outcome));
  const direct = assessed.filter((t) => t.assessment.route === 'direct');
  const lookup = assessed.filter((t) => t.assessment.route !== 'direct');
  const success = (list: TrialRecord[]) => rate(list.filter((t) => t.outcome === 'pass').length, list.length);
  const language = trials.filter((t) => t.language && t.language.ok !== null);
  return {
    verdict,
    reasons,
    missing: missing.length,
    trials: trials.length,
    violations: main.filter((t) => t.outcome === 'violation').length,
    complexRate: rate(complex.filter((t) => t.outcome === 'pass').length, complex.length),
    simpleRate: rate(simple.filter((t) => t.outcome === 'pass').length, simple.length),
    byCategory,
    speed: {
      medianSimpleMs: median(simple.map((t) => t.durationMs)),
      firstTokenMs: median(simple.map((t) => t.stats?.firstTokenMs)),
      tps: median(byTime.slice(0, Math.max(3, Math.floor(byTime.length / 5))).map((t) => t.stats?.tps)),
      tpsLate: median(tail.map((t) => t.stats?.tps)),
      thermalMin: trials.length ? Math.min(...trials.map((t) => t.thermal ?? 100)) : null,
    },
    memoryPeakMb: Math.max(0, ...trials.map((t) => t.memoryPeakMb ?? 0)) || null,
    tools: { ...counters, misuseRate: rate(misuse, counters.calls) },
    censorship: {
      asked: censorship.length,
      refused: censorship.filter((t) => t.censorship === 'refused').length,
      partial: censorship.filter((t) => t.censorship === 'partial').length,
      refusalRate: rate(censorship.filter((t) => t.censorship === 'refused').length, censorship.length),
    },
    metacognition: {
      assessed: assessed.length,
      overconfident: trials.filter((t) => t.assessmentMiss === 'overconfident').length,
      underconfident: trials.filter((t) => t.assessmentMiss === 'underconfident').length,
      blind: trials.filter((t) => t.assessmentMiss === 'blind').length,
      unreadable: trials.reduce((n, t) => n + (t.assessment?.unreadable ?? 0), 0),
      retries: trials.reduce((n, t) => n + (t.assessment?.retries ?? 0), 0),
      directShare: rate(direct.length, assessed.length),
      directSuccess: success(direct), // (low: it is sure of itself and wrong)
      lookupSuccess: success(lookup),
      thinkingChars: median(assessed.map((t) => t.assessment.thinkingChars)),
    },
    contexts,
    languageErrors: language.filter((t) => t.language?.ok === false).length,
  };
}

const ORDER = { passed: 0, provisional: 1, eliminated: 2, unevaluated: 3 };

/** `items`: [{ summary, ... }]. The gate first, then the complex tasks, then the tools, then the time and the first token. */
export function rank<T extends { summary: Rankable }>(items: T[]) {
  return [...items].sort((a, b) => {
    const A = a.summary;
    const B = b.summary;
    if (A.verdict !== B.verdict) return ORDER[A.verdict] - ORDER[B.verdict];
    const dc = (B.complexRate ?? -1) - (A.complexRate ?? -1);
    if (Math.abs(dc) > CLOSE) return dc;
    const dt = (A.tools.misuseRate ?? 1) - (B.tools.misuseRate ?? 1);
    if (dt) return dt;
    const ta = A.speed.medianSimpleMs ?? Infinity;
    const tb = B.speed.medianSimpleMs ?? Infinity;
    const fa = A.speed.firstTokenMs;
    const fb = B.speed.firstTokenMs;
    if (fa != null && fb != null && fa !== fb && Math.abs(ta - tb) <= CLOSE_TIME * Math.min(ta, tb)) return fa - fb;
    return ta === tb ? 0 : ta - tb;
  });
}

/**
 * Two campaigns of one model or two models, on the tasks they share. Only a same
 * machine and suite compare directly; a changed Poney is a warning.
 */
export function compare(a: LoadedCampaign, b: LoadedCampaign) {
  const warnings = [];
  const fa = a.fingerprint;
  const fb = b.fingerprint;
  const direct = fa.machine.chip === fb.machine.chip && fa.machine.memoryGb === fb.machine.memoryGb && fa.suite.major === fb.suite.major;
  if (!direct) warnings.push('Machines ou versions de suite différentes : comparaison indicative seulement.');
  if (fa.poney.commit !== fb.poney.commit) warnings.push(`Poney a changé (${fa.poney.commit?.slice(0, 7)} → ${fb.poney.commit?.slice(0, 7)}) : regarder le modèle de référence.`);
  if (fa.poney.systemPromptHash !== fb.poney.systemPromptHash) warnings.push('Le prompt système a changé.');
  if (fa.poney.engineBuild !== fb.poney.engineBuild) warnings.push('Le moteur a changé : les vitesses ne se comparent plus.');
  const key = (t: TrialRecord) => `${t.task}:${t.taskVersion}`;
  const seen = (list: TrialRecord[]) => new Set(list.filter((t) => t.primary && t.outcome !== 'infra' && t.outcome !== 'invalid').map(key));
  const sa = seen(a.trials);
  const common = [...seen(b.trials)].filter((k) => sa.has(k));
  const passRate = (list: TrialRecord[]) => {
    const kept = list.filter((t) => t.primary && common.includes(key(t)) && ['pass', 'fail', 'violation'].includes(t.outcome));
    return rate(kept.filter((t) => t.outcome === 'pass').length, kept.length);
  };
  return { direct, warnings, commonTasks: common.length, a: passRate(a.trials), b: passRate(b.trials) };
}
