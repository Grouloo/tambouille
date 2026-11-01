import { describe, expect, test } from 'bun:test';
import { analyzeAssessment, analyzeEvents, assessmentMiss, detectLanguage, finalAnswers, inventedTools, sumStats } from '../src/analyze.ts';
import { parseVerdict, judgePrompt } from '../src/judge.ts';
import { fitBudget, planTrials, trialKey } from '../src/plan.ts';
import { trialSettings } from '../src/poney.ts';
import { profile } from '../src/sandbox.ts';
import { compare, comparison, gate, rank, summarize } from '../src/score.ts';
import { missingTools } from '../src/trial.ts';
import { search } from '../src/fakeweb.ts';
import { publicJson } from '../src/store.ts';
import os from 'node:os';
import type { PoneySettings } from '../src/poney.ts';
import type { Assessment, LoadedCampaign, Miss, Outcome, Task, Tier, ToolUse, TrialRecord, Verdict } from '../src/types.ts';
import { filler, finalValue } from '../suite/lib/helpers.ts';

const task = (id: string, category: string, tier: Tier): Task => ({ id, category, tier, version: 1, lang: 'en', check: () => ({ pass: true }), solve: () => '' });
/** A partial shape standing for a whole one: a test only sets what it reads. */
const as = <T>(value: unknown) => value as T;
const TASKS = [task('s1', 'code', 'simple'), task('s2', 'harness', 'simple'), task('c1', 'harness', 'complex'), task('r1', 'rules', 'rules'), task('z1', 'censorship', 'censorship')];
const trial = (t: string, outcome: Outcome, extra: Partial<TrialRecord> = {}) => as<TrialRecord>({ type: 'trial', key: `${t}#${extra.rep ?? 1}`, task: t, taskVersion: 1, category: 'code', tier: 'simple', outcome, primary: true, at: '2026-01-01', numCtx: 32000, ...extra });

describe('plan', () => {
  const plan = planTrials(TASKS, { numCtx: 32000, extraContexts: [16000], reps: 3 });
  test('the floor and the rules come first, contexts last', () => {
    expect(plan.map((e) => e.phase).filter((p, i, l) => p !== l[i - 1])).toEqual(['floor', 'rules', 'complex', 'censorship', 'repeats', 'contexts']);
  });
  test('only simple tasks repeat, keys are unique', () => {
    expect(plan.filter((e) => e.task.id === 's1' && e.numCtx === 32000).length).toBe(3);
    expect(plan.filter((e) => e.task.id === 'c1' && e.numCtx === 32000).length).toBe(1);
    expect(new Set(plan.map(trialKey)).size).toBe(plan.length);
  });
  test('only the harness tasks play at other contexts', () => {
    expect(plan.filter((e) => e.numCtx === 16000).map((e) => e.task.id)).toEqual(['s2', 'c1']);
  });
  test('a smaller budget plays fewer trials, in the same order', () => {
    const small = fitBudget(plan, 25);
    expect(small.fit.length).toBeLessThan(plan.length);
    expect(small.fit[0]).toBe(plan[0]);
    expect(small.mandatoryComplete).toBe(false);
    expect(fitBudget(plan, 10000).complete).toBe(true);
  });
  test('measured times replace the defaults', () => {
    expect(fitBudget(plan, 25, { simple: 0.5, complex: 0.5, rules: 0.5, censorship: 0.5 }).complete).toBe(true);
  });
});

describe('gate', () => {
  const simple = (id: string, outcome: Outcome, rep: number, category = 'code') => trial(id, outcome, { rep, category });
  test('one isolated failure per category is allowed', () => {
    expect(gate([simple('a', 'fail', 1), simple('a', 'pass', 2), simple('b', 'fail', 1, 'math')]).eliminated).toBe(false);
  });
  test('two failures in a category eliminate', () => {
    expect(gate([simple('a', 'fail', 1), simple('b', 'fail', 1)]).reasons[0]).toContain('2 échecs simples');
  });
  test('a task failed twice eliminates', () => {
    expect(gate([simple('a', 'fail', 1), simple('a', 'fail', 2)]).reasons.join()).toContain('ratée 2 fois');
  });
  test('a violation eliminates, a plain failure of a rule task does not', () => {
    expect(gate([trial('r', 'violation', { tier: 'rules' })]).eliminated).toBe(true);
    expect(gate([trial('r', 'fail', { tier: 'rules' })]).eliminated).toBe(false);
  });
});

describe('verdicts', () => {
  test('missing trials leave it provisional, unjudged ones too', () => {
    expect(summarize([trial('a', 'pass')], ['a#1', 'b#1']).verdict).toBe('provisional');
    expect(summarize([trial('a', 'unjudged')], ['a#1']).verdict).toBe('provisional');
    expect(summarize([trial('a', 'pass')], ['a#1']).verdict).toBe('passed');
    expect(summarize([]).verdict).toBe('unevaluated');
    expect(summarize([trial('a', 'infra')], ['a#1']).verdict).toBe('unevaluated');
  });
  test('an elimination is final even when incomplete', () => {
    expect(summarize([trial('a', 'violation', { tier: 'rules' })], ['a#1', 'b#1']).verdict).toBe('eliminated');
  });
  test('infrastructure failures do not count', () => {
    expect(summarize([trial('a', 'infra'), trial('a', 'pass')], ['a#1']).trials).toBe(1);
  });
  const summary = (verdict: Verdict, complexRate: number | null, misuseRate: number | null, ms = 1000) => ({ summary: { verdict, complexRate, tools: { misuseRate }, speed: { medianSimpleMs: ms } } });
  test('ranks by the gate, then complex tasks, then tools', () => {
    const out = rank([summary('eliminated', 1, 0), summary('passed', 0.5, 0), summary('passed', 0.9, 0.5), summary('provisional', 1, 0)]);
    expect(rank([summary('unevaluated', null, null), summary('eliminated', 0, 1)])[0].summary.verdict).toBe('eliminated');
    expect(out.map((x) => [x.summary.verdict, x.summary.complexRate])).toEqual([['passed', 0.9], ['passed', 0.5], ['provisional', 1], ['eliminated', 1]]);
  });
  test('close complex rates: the cleaner use of tools wins', () => {
    const withSlop = (slopRate: number) => ({ summary: { ...summary('passed', 1, 0).summary, slopRate } });
    expect(rank([withSlop(0.8), withSlop(0.2)])[0]?.summary.slopRate).toBe(0.2);
    expect(rank([withSlop(0.25), withSlop(0.2)])[0]?.summary.slopRate).toBe(0.25);
    const first = (ms: number, firstTokenMs: number) => ({ summary: { verdict: 'passed' as const, complexRate: 1, tools: { misuseRate: 0 }, speed: { medianSimpleMs: ms, firstTokenMs } } });
    expect(rank([first(1000, 900), first(1050, 200)])[0].summary.speed.firstTokenMs).toBe(200);
    expect(rank([first(1000, 900), first(2000, 200)])[0].summary.speed.firstTokenMs).toBe(900);
    const out = rank([summary('passed', 0.7, 0.3), summary('passed', 0.67, 0.1)]);
    expect(out[0].summary.complexRate).toBe(0.67);
  });
});

describe('compare', () => {
  const fp = (commit: string, chip = 'M4') => ({ machine: { chip, memoryGb: 24 }, suite: { major: 1 }, poney: { commit, systemPromptHash: commit, engineBuild: 'b' } });
  test('on common tasks only, with a warning if Poney changed', () => {
    const c = compare(as<LoadedCampaign>({ fingerprint: fp('aaa'), trials: [trial('a', 'pass'), trial('b', 'pass')] }), as<LoadedCampaign>({ fingerprint: fp('bbb'), trials: [trial('a', 'fail')] }));
    expect(c).toMatchObject({ direct: true, commonTasks: 1, a: 1, b: 0 });
    expect(c.warnings.join()).toContain('Poney a changé');
  });
  test('another machine is not a direct comparison', () => {
    expect(compare(as<LoadedCampaign>({ fingerprint: fp('a', 'M1'), trials: [] }), as<LoadedCampaign>({ fingerprint: fp('a'), trials: [] })).direct).toBe(false);
  });
});

describe('comparison', () => {
  const fp = (commit: string, chip = 'M4') => ({ machine: { chip, memoryGb: 24 }, suite: { major: 1 }, poney: { commit, systemPromptHash: 'p', engineBuild: 'b' } });
  const on = (model: string, task: string, outcome: Outcome) => ({ ...trial(task, outcome), model, at: '2026-01-01' });
  const campaign = (id: string, startedAt: string, fingerprint: unknown, models: string[], trials: unknown[]) => as<LoadedCampaign>({ id, startedAt, fingerprint, fullSuite: true, probes: [], models: models.map((m) => ({ id: m })), trials });
  const campaigns = [
    campaign('old', '2026-01-01', fp('aaa'), ['x', 'y'], [on('x', 'a', 'fail'), on('y', 'a', 'pass'), on('y', 'b', 'pass')]),
    campaign('new', '2026-02-01', fp('bbb'), ['x', 'y'], [on('x', 'a', 'pass'), on('x', 'b', 'pass')]),
    campaign('elsewhere', '2026-03-01', fp('aaa', 'M1'), ['z'], [on('z', 'a', 'pass')]),
  ];
  test('each model on its latest evaluation, on the chosen machine only', () => {
    const c = comparison(campaigns, { machine: 'M4 · 24 Go' });
    expect(c.machines).toEqual(['M1 · 24 Go', 'M4 · 24 Go']);
    expect(c.models.sort()).toEqual(['x', 'y']);
    expect(Object.fromEntries(c.ranking.map((m) => [m.model, m.campaign]))).toEqual({ x: 'new', y: 'old' }); // (y played nothing in 'new')
    expect(c.warnings.join()).toContain('Poney');
  });
  test('rates are on the tasks shared by the models kept', () => {
    const both = comparison(campaigns, { machine: 'M4 · 24 Go' });
    expect(both.commonTasks).toBe(2);
    expect(comparison(campaigns, { machine: 'M4 · 24 Go', without: ['y'] })).toMatchObject({ commonTasks: 2, warnings: [], models: expect.arrayContaining(['x', 'y']) });
  });
  test('the most recent machine comes first', () => expect(comparison(campaigns).machine).toBe('M1 · 24 Go'));
});

describe('analysis of a run', () => {
  test('finds invented tools, not code or HTML', () => {
    expect(inventedTools('<search_files path="x" /> <read path="a" /> <div>x</div> `<nope_tool />`')).toEqual(['search_files']);
    expect(inventedTools('```\n<fake_tool/>\n```')).toEqual([]);
    expect(inventedTools('<tool_call>{"name": "list_dir", "arguments": {}}</tool_call>')).toEqual(['list_dir']);
    expect(inventedTools('<|tool_call>call:browse_web{url:"x"}')).toEqual(['browse_web']);
    expect(inventedTools('<write path="a.html"><magic_tag /></write>')).toEqual([]);
  });
  test('counts failed, repaired, repeated calls', () => {
    const c = analyzeEvents([
      { type: 'action_start', id: 1, tool: 'read', args: { path: 'a' }, calledAs: 'cat' },
      { type: 'action_end', id: 1, ok: false },
      { type: 'action_start', id: 2, tool: 'read', args: { path: 'a' }, calledAs: 'gemma:read' },
      { type: 'action_end', id: 2, ok: true },
      { type: 'action_start', id: 3, tool: 'run', args: { command: 'false' } },
      { type: 'action_end', id: 3, ok: false },
      { type: 'notice', text: 'Le modèle répétait le même passage en boucle' },
      { type: 'compaction' },
    ]);
    expect(c).toMatchObject({ calls: 3, failedCalls: 1, repairedAliases: 1, repeatedActions: 1, loops: 1, compactions: 1 });
  });
  test('final answers ignore sub-agents', () => {
    expect(finalAnswers([
      { type: 'assistant_end', text: 'first' }, { type: 'turn_end' },
      { type: 'assistant_end', text: 'sub', agentId: 1 }, { type: 'assistant_end', text: 'second' }, { type: 'turn_end' },
    ])).toEqual(['first', 'second']);
  });
  test('stats add up over turns', () => {
    expect(sumStats([{ type: 'turn_end', stats: { steps: 2, tokens: 100, genMs: 1000, promptMs: 5 } }, { type: 'turn_end', stats: { steps: 1, tokens: 100, genMs: 1000, promptMs: 5 } }])).toMatchObject({ steps: 3, tps: 100 });
  });
  test('detects the language, not on too little text', () => {
    expect(detectLanguage('Le chat est sur la table et il ne veut pas descendre pour le dîner avec nous.')).toBe('fr');
    expect(detectLanguage('The cat is on the table and it does not want to come down for dinner with us.')).toBe('en');
    expect(detectLanguage('OK')).toBeNull();
  });
  test('expected tools', () => {
    expect(missingTools({ tools: [['recall', 'remember'], ['read']] }, as<ToolUse>({ used: { remember: 1 } }), [])).toEqual(['read']);
    expect(missingTools({ minFetches: 2 }, as<ToolUse>({ used: { fetch: 1 } }), [])).toEqual(['2 fetch']);
    expect(missingTools({ readWindow: true }, as<ToolUse>({ used: {} }), [{ type: 'action_start', tool: 'read', args: { start: 5 } }])).toEqual([]);
  });
});

describe('the assessment', () => {
  const triage = (route: string, extra = {}) => ({ type: 'triage', route, known: [{}], doubts: [], unknowns: [], ...extra });
  test('keeps the first assessment of the last message, not its updates or a sub-agent', () => {
    const a = analyzeAssessment([
      { type: 'turn_start' }, triage('investigate'), { type: 'turn_end' },
      { type: 'turn_start' }, triage('check', { agentId: 1 }), triage('direct'), triage('investigate', { update: true }),
      { type: 'assistant_end', thinking: 'abcd' }, { type: 'notice', text: 'Bilan coupé pendant la réflexion du modèle : nouvel essai (2/3).' },
    ]);
    expect(a).toMatchObject({ route: 'direct', updates: 1, retries: 1, thinkingChars: 4 });
  });
  test('an assessment that could not be read has no route', () => {
    expect(analyzeAssessment([triage('check', { failed: true })])).toMatchObject({ route: null, unreadable: 1 });
    expect(analyzeAssessment([])).toBeNull();
  });
  test('tells over-confidence from under-confidence', () => {
    const a = (route: string, known: number, unsure: number) => as<Assessment>({ route, known, doubts: unsure, unknowns: 0 });
    expect(assessmentMiss('lookup', a('direct', 2, 0))).toBe('overconfident');
    expect(assessmentMiss('lookup', a('check', 0, 1))).toBeNull();
    expect(assessmentMiss('direct', a('check', 1, 1))).toBe('underconfident');
    expect(assessmentMiss('direct', a('direct', 1, 0))).toBeNull();
    expect(assessmentMiss('mixed', a('direct', 2, 0))).toBe('overconfident');
    expect(assessmentMiss('mixed', a('investigate', 0, 2))).toBe('blind');
    expect(assessmentMiss('mixed', a('check', 1, 1))).toBeNull();
    expect(assessmentMiss('lookup', null)).toBe('unreadable');
    expect(assessmentMiss(undefined, null)).toBeNull();
  });
  test('sums up how sure the model was, and how right', () => {
    const t = (route: string, outcome: Outcome, assessmentMiss?: Miss) => trial('a', outcome, { assessment: as<Assessment>({ route, thinkingChars: 10 }), assessmentMiss });
    const c = summarize([t('direct', 'pass'), t('direct', 'fail', 'overconfident'), t('check', 'pass')]).metacognition;
    expect(c).toMatchObject({ overconfident: 1, assessed: 3, directSuccess: 0.5, lookupSuccess: 1, thinkingChars: 10 });
  });
});

describe('small parts', () => {
  test('results keep no path of this machine', () => {
    const text = publicJson({ models: [{ id: 'm', file: '/x/m.gguf' }], reason: `boom in ${os.homedir()}/a` });
    expect(text).not.toContain('m.gguf');
    expect(text).not.toContain(os.homedir());
    expect(text).toContain('~/a');
  });
  test('the final value of an answer', () => {
    expect(finalValue('blah\nANSWER: **42**')).toBe('42');
    expect(finalValue('answer: 1\nRéponse : 2')).toBe('2');
  });
  test('filler is deterministic and the right size', () => {
    expect(filler(100, 2)).toBe(filler(100, 2));
    expect(filler(1000).length).toBeGreaterThan(3900);
  });
  test('search ranks titles first and finds nothing for nothing', () => {
    const pages = [{ slug: 'a', title: 'Other', body: 'kestrel' }, { slug: 'b', title: 'Kestrel', body: 'x' }];
    expect(search(pages, 'Kestrel').map((p) => p.slug)).toEqual(['b', 'a']);
    expect(search(pages, 'zzz')).toEqual([]);
  });
  test('a trial never gets Tor unless asked, and no API key', () => {
    const s = trialSettings(as<PoneySettings>({ config: { torEnabled: true, torShell: true }, modelContexts: { x: 1 } }), { numCtx: 16000, searxngUrl: 'http://w', tor: false });
    expect(s.config).toMatchObject({ torEnabled: false, torShell: false, numCtx: 16000, searxngUrl: 'http://w' });
    expect(s.modelContexts).toEqual({});
    expect(trialSettings(as<PoneySettings>({ config: {} }), { numCtx: 1, searxngUrl: 'http://w', tor: true }).config.searxngUrl).toBe('');
  });
  test('the profile denies by default and lists its ports', () => {
    const p = profile({ dirs: { root: '/r', work: '/r/work', home: '/r/home', tmp: '/r/tmp', ctl: '/r/ctl' }, ports: [1234], readable: ['/m/x.gguf'] });
    expect(p).toContain('(deny default)');
    expect(p).toContain('localhost:1234');
    expect(p).toContain('(literal "/m/x.gguf")');
    expect(p).not.toContain('file-write* (subpath "/r/ctl")');
  });
  test('the judge gets the output as data', () => {
    expect(judgePrompt({ prompt: 'p', rubric: 'r', answer: 'a' })).toContain('<output>\na\n</output>');
    expect(parseVerdict(JSON.stringify({ structured_output: { score: 1, reasons: 'x' } })).score).toBe(1);
    expect(parseVerdict(JSON.stringify({ result: 'ok {"score": 0.5, "reasons": "y"}' })).score).toBe(0.5);
    expect(() => parseVerdict(JSON.stringify({ is_error: true, result: 'no' }))).toThrow();
  });
});

test('the activity of a trial survives an incomplete last line', async () => {
  const { activityOf } = await import('../src/progress.ts');
  const lines = [{ type: 'triage', route: 'investigate', known: [], doubts: [], unknowns: [1] }, { type: 'action_start', id: 1, tool: 'read', args: { path: 'a.txt' } }, { type: 'action_end', id: 1, ok: false }, { type: 'assistant_start' }, { type: 'delta', kind: 'thinking', text: 'hm' }];
  const a = activityOf(`${lines.map((l) => JSON.stringify(l)).join('\n')}\n{"type":"del`);
  expect(a.steps[1]).toEqual({ kind: 'tool', tool: 'read', text: 'a.txt', ok: false });
  expect(a.draft).toEqual({ kind: 'thinking', text: 'hm' });
});
test('every planned trial has a state, and a result wins over the current key', async () => {
  const { trialRows } = await import('../src/progress.ts');
  const rows = trialRows(['a@1#1', 'b@1#1', 'c@1#1'], [trial('a', 'fail', { key: 'a@1#1', reason: 'non' }), trial('x', 'pass', { key: 'x@1#1' })], 'b@1#1');
  expect(rows.map((r) => r.state)).toEqual(['fail', 'running', 'pending', 'pass']);
  expect(trialRows(['a@1#1'], [trial('a', 'pass', { key: 'a@1#1' })], 'a@1#1')[0].state).toBe('pass');
});

test('a transcript keeps its steps and the unfinished answer', async () => {
  const { transcriptOf } = await import('../src/progress.ts');
  const raw = [{ type: 'action_start', id: 1, tool: 'run', args: { command: 'ls' } }, { type: 'action_end', id: 1, ok: true, output: 'x' }, { type: 'assistant_end', text: 'fini', thinking: 'hm' }, { type: 'assistant_start' }, { type: 'delta', text: 'en co' }].map((l) => JSON.stringify(l)).join('\n');
  expect(transcriptOf(raw).map((e) => e.kind)).toEqual(['tool', 'thinking', 'answer', 'draft']);
});
test('the time left follows the trials played, within the budget', async () => {
  const { modelState } = await import('../src/progress.ts');
  const rows = [{ state: 'pass', durationMs: 60000 }, { state: 'running' }];
  const base = { started: true, index: 0, lastStarted: 0, rows, total: 4, budgetMinutes: 60, live: true };
  expect(modelState(base)).toEqual({ state: 'running', remainingMs: 180000 });
  expect(modelState({ ...base, budgetMinutes: 2 }).remainingMs).toBe(60000);
  expect(modelState({ ...base, started: false }).state).toBe('waiting');
  expect(modelState({ ...base, rows: [], total: 0 }).state).toBe('running');
  expect(modelState({ ...base, index: 0, lastStarted: 1 }).state).toBe('done');
  expect(modelState({ ...base, live: false }).state).toBe('interrupted');
});

test('no source says any', async () => {
  const found: string[] = [];
  for (const dir of ['src', 'suite', 'test']) {
    for await (const file of new Bun.Glob('**/*.ts').scan(dir)) {
      if (file.startsWith('fixtures/')) continue;
      const text = await Bun.file(`${dir}/${file}`).text();
      if (/(?::|<|\bas|\||&)\s*any\b(?![-' ]\w)/.test(text.replace(/'[^'\n]*'|`[^`]*`|\/\/.*$/gm, ''))) found.push(`${dir}/${file}`);
    }
  }
  expect(found).toEqual([]);
});
