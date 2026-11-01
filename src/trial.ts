// One trial: a fresh sandbox, the agent, the check, the record.
import fs from 'node:fs/promises';
import path from 'node:path';
import { analyzeAssessment, analyzeEvents, assessmentMiss, detectLanguage, finalAnswers, sumStats } from './analyze.ts';
import { PROTOCOL } from './config.ts';
import { taskContext } from './context.ts';
import { judge } from './judge.ts';
import { gradeSlop } from './slop.ts';
import { killStrays, portOpen, sampleMemory, thermalLimit } from './machine.ts';
import { trialKey } from './plan.ts';
import { agentArgs, trialSettings } from './poney.ts';
import { createRoot, removeRoot, wrap } from './sandbox.ts';
import { transcriptPath } from './store.ts';
import { message } from './types.ts';
import type { Engine, PoneySettings } from './poney.ts';
import type { AgentEvent, CampaignModel, CheckResult, Expects, Miss, Outcome, PlanEntry, Task, TaskJudge, ToolUse, TrialRecord } from './types.ts';

interface TrialOptions {
  campaign: string; entry: PlanEntry; model: CampaignModel; engine: Engine; web: { port: number; url: string }; settings: PoneySettings;
  primary: boolean; signal?: AbortSignal; pendingDir: string; verify?: boolean;
}

const messagesOf = (task: Task, numCtx: number): string[] => {
  if (typeof task.messages === 'function') return task.messages({ numCtx });
  return task.messages ?? [task.prompt ?? ''];
};

/** The outcomes that say nothing of the model replay; see docs/design.md. */
export const replayed = (outcome: Outcome) => outcome === 'infra';

/** Which expected uses of the tools are missing. */
export function missingTools(expects: Expects | undefined, tools: ToolUse, events: AgentEvent[]) {
  if (!expects) return [];
  const missing: string[] = [];
  for (const anyOf of expects.tools ?? []) if (!anyOf.some((t) => tools.used[t])) missing.push(anyOf.join('|'));
  if (expects.minFetches && (tools.used.fetch ?? 0) < expects.minFetches) missing.push(`${expects.minFetches} fetch`);
  if (expects.readWindow && !events.some((e) => e.type === 'action_start' && e.tool === 'read' && e.args?.start)) missing.push('read start=');
  return missing;
}

const MISSES: Record<Miss, string> = { overconfident: 'sûr de lui à tort', underconfident: 'doute de ce qu’il sait', blind: 'ne reconnaît pas ce qu’il sait', unreadable: 'illisible' };

const torUp = async () => (await portOpen(9050)) || portOpen(9150);

async function runAgent({ cmd, env, cwd, transcript, timeoutMs, signal }: { cmd: string[]; env: Record<string, string>; cwd: string; transcript: string; timeoutMs: number; signal?: AbortSignal }) {
  await fs.mkdir(path.dirname(transcript), { recursive: true });
  const out = Bun.file(transcript).writer();
  const p = Bun.spawn(cmd, { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  let timedOut = false;
  const stop = () => {
    p.kill('SIGTERM');
    setTimeout(() => { if (p.exitCode === null) p.kill('SIGKILL'); }, 10000);
  };
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  signal?.addEventListener('abort', stop);
  const events: AgentEvent[] = [];
  const stderr = new Response(p.stderr).text();
  const decoder = new TextDecoder();
  let rest = '';
  for await (const chunk of p.stdout) {
    out.write(chunk);
    rest += decoder.decode(chunk, { stream: true });
    const parts = rest.split('\n');
    rest = parts.pop() ?? '';
    for (const line of parts) {
      try {
        const ev = JSON.parse(line) as AgentEvent;
        if (ev.type !== 'delta') events.push(ev);
      } catch { /* not an event */ }
    }
  }
  const exit = await p.exited;
  clearTimeout(timer);
  signal?.removeEventListener('abort', stop);
  await out.end();
  return { exit, timedOut, events, stderr: (await stderr).slice(-600) };
}

/** Grades what a judge can grade, or marks the trial to be judged later. */
async function applyJudge(record: TrialRecord, task: Task & { judge: TaskJudge }, text: string, numCtx: number, pendingDir: string) {
  const prompt = messagesOf(task, numCtx).at(-1) ?? '';
  try {
    const v = await judge({ prompt, rubric: task.judge.rubric, answer: text });
    record.judge = { model: v.model, score: v.score, level: v.level ?? null, reasons: v.reasons };
    if (task.judge.censorship) {
      record.censorship = v.level === 'refused' || v.score === 0 ? 'refused' : v.level === 'partial' || v.score < 1 ? 'partial' : 'answered';
      record.outcome = record.censorship === 'answered' ? 'pass' : 'fail';
    } else if (v.score < (task.judge.threshold ?? 0)) {
      record.outcome = 'fail';
      record.reason = 'jugement sous le seuil';
    }
  } catch (e) {
    record.outcome = 'unjudged';
    record.reason = message(e).slice(0, 200);
    await fs.mkdir(pendingDir, { recursive: true });
    await Bun.write(path.join(pendingDir, `${record.key.replace(/[^\w.@#-]+/g, '_')}.json`), JSON.stringify({ prompt, answer: text }));
  }
}

/** The slop of what passed. An unreachable judge leaves it for `rejudge`, like a verdict. */
async function applySlop(record: TrialRecord, slop: NonNullable<Task['slop']>, prompt: string, text: string, pendingDir: string) {
  try {
    record.slop = await gradeSlop({ prompt, kind: slop.kind, text });
  } catch {
    record.slopPending = true;
    await fs.mkdir(pendingDir, { recursive: true });
    await Bun.write(path.join(pendingDir, `${record.key.replace(/[^\w.@#-]+/g, '_')}.slop.json`), JSON.stringify({ prompt, kind: slop.kind, text }));
  }
}

export async function runTrial({ campaign, entry, model, engine, web, settings, primary, signal, pendingDir, verify = true }: TrialOptions): Promise<TrialRecord> {
  const { task, numCtx, rep, phase } = entry;
  const key = trialKey(entry);
  const base: Omit<TrialRecord, 'outcome'> = {
    type: 'trial', key, at: new Date().toISOString(), task: task.id, taskVersion: task.version, category: task.category, tier: task.tier, lang: task.lang,
    model: model.id, numCtx, rep, phase, primary,
  };
  const tor = task.web === 'tor';
  if (tor && !(await torUp())) return { ...base, outcome: 'skipped', reason: 'Tor coupé' };

  const dirs = await createRoot(`${campaign}-${model.id.slice(0, 24)}-${key}`);
  const ports = [engine.port, web.port, ...(tor ? [9050, 9150] : [])];
  const sandbox = { readable: model.file ? [model.file] : [], ports };
  try {
    await task.setup?.(taskContext({ dirs, numCtx }));
    const messages = messagesOf(task, numCtx);
    await fs.writeFile(path.join(dirs.ctl, 'key'), engine.apiKey, { mode: 0o600 });
    await fs.writeFile(path.join(dirs.ctl, 'script.json'), JSON.stringify(messages));
    await fs.writeFile(path.join(dirs.ctl, 'settings.json'), JSON.stringify(trialSettings(settings, { numCtx, searxngUrl: web.url, tor })));

    const argv = agentArgs({ model: model.id, numCtx, engineUrl: engine.baseUrl, ctl: dirs.ctl, cwd: dirs.work, tor });
    if (task.testCommand) argv.push('--test-command', task.testCommand);
    const { cmd, env } = await wrap(argv, { dirs, ...sandbox });
    const transcript = transcriptPath(campaign, `${model.id}-${key}`);
    const memory = sampleMemory(engine.pid, { wiredBefore: engine.wiredBefore });
    const t0 = Date.now();
    const run = await runAgent({ cmd, env, cwd: dirs.work, transcript, timeoutMs: (task.trialMinutes ?? PROTOCOL.trialMinutes) * 60000, signal });
    const durationMs = Date.now() - t0;
    const memoryPeakMb = await memory.stop();
    await killStrays(dirs.tmp);

    const record: TrialRecord = { ...base, outcome: 'fail', durationMs, exit: run.exit, memoryPeakMb, thermal: await thermalLimit(), stats: sumStats(run.events) };
    if (signal?.aborted) return { ...record, outcome: 'invalid', reason: 'campagne arrêtée' };
    if (!run.events.length || run.exit === 1) return { ...record, outcome: 'infra', reason: run.stderr || `exit ${run.exit} sans événement` };
    if (!verify) return { ...record, outcome: 'pass', events: run.events };

    const tools = analyzeEvents(run.events);
    const answers = finalAnswers(run.events);
    const answer = answers.at(-1) ?? '';
    record.tools = tools;
    record.assessment = analyzeAssessment(run.events);
    const ctx = { ...taskContext({ dirs, numCtx, sandbox: { ...sandbox, ports: [] }, phase: 'check' }), answer, answers, events: run.events };

    // The check runs even after a bad end: a violation stays a violation.
    let verdict: CheckResult;
    try {
      verdict = await task.check(ctx);
    } catch (e) {
      verdict = { pass: false, detail: `vérification : ${message(e).slice(0, 200)}` };
    }
    record.detail = verdict.detail ? String(verdict.detail).slice(0, 400) : undefined;
    if (verdict.violation) return { ...record, outcome: 'violation', reason: verdict.violation };
    if (run.timedOut) return { ...record, outcome: 'fail', reason: 'temps dépassé' };
    if (!engine.alive()) return { ...record, outcome: 'fail', reason: 'le moteur s’est arrêté (mémoire ?)' };
    if (run.exit === 2) return { ...record, outcome: 'fail', reason: 'limite d’étapes atteinte' };
    if (run.exit !== 0) return { ...record, outcome: 'fail', reason: 'boucle, silence ou erreur du modèle' };

    record.forgotten = missingTools(task.expects, tools, run.events);
    if (task.expects?.compaction && !tools.compactions) record.forgotten = []; // (the window was not filled: nothing to retrieve)
    const lastLang = task.lastLang ?? task.lang;
    const target = task.judge?.target ? (await ctx.file(task.judge.target)) ?? '' : answer;
    const got = detectLanguage(target);
    record.language = { expected: lastLang, got, ok: got ? got === lastLang : null };

    record.outcome = verdict.pass ? 'pass' : 'fail';
    if (!verdict.pass) record.reason = 'vérification échouée';
    if (record.forgotten.length) {
      record.outcome = 'fail';
      record.reason = `outil attendu non utilisé : ${record.forgotten.join(', ')}`;
    }
    record.assessmentMiss = assessmentMiss(task.expects?.assessment, record.assessment);
    if (record.assessmentMiss) {
      record.outcome = 'fail';
      record.reason = `bilan : ${MISSES[record.assessmentMiss]}`;
    }
    if (task.category === 'writing' && record.language.ok === false) {
      record.outcome = 'fail';
      record.reason = `mauvaise langue : ${got}`;
    }
    if (task.judge && (record.outcome === 'pass' || task.judge.censorship)) await applyJudge(record, { ...task, judge: task.judge }, target, numCtx, pendingDir);
    if (task.slop && record.outcome === 'pass') {
      const contents = await Promise.all((task.slop.files ?? []).map(async (f) => `--- ${f} ---\n${(await ctx.file(f)) ?? ''}`));
      await applySlop(record, task.slop, messagesOf(task, numCtx).at(-1) ?? '', contents.length ? contents.join('\n\n') : answer, pendingDir);
    }
    return record;
  } catch (e) {
    return { ...base, outcome: 'infra', reason: message(e).slice(0, 300) };
  } finally {
    await removeRoot(dirs);
  }
}
