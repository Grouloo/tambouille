// A whole campaign against a fake Poney: real sandbox, real files, no model.
import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tambouille-test-'));
const repo = path.resolve(import.meta.dir, '..');
const fake = path.join(repo, 'test', 'fixtures', 'fake-poney');
const model = path.join(tmp, 'fake.gguf');
const appData = path.join(tmp, 'app');
Object.assign(process.env, { PONEY_DIR: fake, PONEY_APP_DATA: appData, TAMBOUILLE_DATA: path.join(tmp, 'data'), TAMBOUILLE_RESULTS: path.join(tmp, 'results'), FAKE_MODEL: model, TAMBOUILLE_CLAUDE: path.join(tmp, 'claude') });

// Refuses to go on if another test file loaded the real paths: it would start real models.
const { PONEY_DIR } = await import('../src/config.js');
if (PONEY_DIR !== fake) throw new Error('run this file alone: bun test test/campaign.test.js (or bun run test)');

const tasks = [
  { id: 'good', version: 1, category: 'code', tier: 'simple', lang: 'en', prompt: 'GOOD', check: async ({ file }) => ({ pass: (await file('answer.txt')) === 'ok' }) },
  { id: 'wrong', version: 1, category: 'math', tier: 'simple', lang: 'en', prompt: 'nothing', check: () => ({ pass: false, detail: 'non' }) },
  { id: 'broken', version: 1, category: 'logic', tier: 'simple', lang: 'en', prompt: 'CRASH', check: () => ({ pass: true }) },
  { id: 'looping', version: 1, category: 'research', tier: 'simple', lang: 'en', prompt: 'LOOP', check: () => ({ pass: true }) },
  { id: 'unused-tool', version: 1, category: 'harness', tier: 'simple', lang: 'en', prompt: 'GOOD', expects: { tools: [['recall']] }, check: () => ({ pass: true }) },
  { id: 'rule', version: 1, category: 'rules', tier: 'rules', lang: 'en', prompt: 'GOOD', check: () => ({ pass: false, violation: 'interdit' }) },
  { id: 'hard', version: 1, category: 'code', tier: 'complex', lang: 'en', prompt: 'GOOD', judge: { rubric: 'r', threshold: 0.7 }, check: () => ({ pass: true }) },
  { id: 'escape', version: 1, category: 'terminal', tier: 'simple', lang: 'en', prompt: 'GOOD ESCAPE', check: ({ events }) => ({ pass: events.some((e) => e.text === 'blocked') }) },
];
mock.module('../suite/index.js', () => ({ TASKS: tasks, SUITE_VERSION: { major: 0, label: 'test' }, selectTasks: () => tasks }));
const machine = await import('../src/machine.js');
mock.module('../src/machine.js', () => ({ ...machine, machineIssues: async () => [] })); // (the state of the real Mac is not under test)

let report;
beforeAll(async () => {
  await fs.writeFile(model, 'x');
  await fs.mkdir(path.join(appData, 'engine', 'fake'), { recursive: true });
  await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify({ config: { numCtx: 32000, apiKey: 'secret', torEnabled: true }, modelContexts: {} }));
  await fs.writeFile(process.env.TAMBOUILLE_CLAUDE, `#!/bin/bash\ncat > /dev/null\necho '{"structured_output":{"score":0.9,"reasons":"fine"}}'\n`, { mode: 0o755 });
  const { prepare, runCampaign, campaignReport } = await import('../src/campaign.js');
  const campaign = await prepare({ budgetMinutes: 600 });
  await runCampaign(campaign, { log: () => {} });
  report = await campaignReport(campaign.id);
}, 120000);
afterAll(() => fs.rm(tmp, { recursive: true, force: true }));

const of = (id) => report.campaign.trials.filter((t) => t.task === id);

test('a passing trial records its stats and tools', () => {
  const [t] = of('good');
  expect(t.outcome).toBe('pass');
  expect(t.stats.tokens).toBe(10);
  expect(t.tools).toMatchObject({ calls: 2, failedCalls: 1, repairedAliases: 1, inventedTools: 1 });
});
test('simple tasks ran three times', () => expect(of('good').length).toBe(3));
test('a wrong result is a failure', () => expect(of('wrong')[0].outcome).toBe('fail'));
test('a crash is replayed, then kept as infrastructure', () => expect(of('broken')[0].outcome).toBe('infra'));
test('a loop is the model\'s failure', () => expect(of('looping')[0]).toMatchObject({ outcome: 'fail', exit: 3 }));
test('a task that passes without the expected tool fails', () => {
  expect(of('unused-tool')[0]).toMatchObject({ outcome: 'fail', forgotten: ['recall'] });
});
test('a violation is recorded and eliminates', () => {
  expect(of('rule')[0]).toMatchObject({ outcome: 'violation', reason: 'interdit' });
  expect(report.ranking[0].summary.verdict).toBe('eliminated');
});
test('the judge scores what passed', () => expect(of('hard')[0]).toMatchObject({ outcome: 'pass', judge: { score: 0.9, model: 'claude-sonnet-5-5' } }));
test('the agent cannot write out of its sandbox', () => expect(of('escape')[0].outcome).toBe('pass'));
test('the fingerprint is recorded', () => {
  expect(report.campaign.fingerprint.poney.commit).toBe('abc1234');
  expect(report.campaign.models[0].sha256).toHaveLength(64);
});
test('the campaign leaves no temporary files and no API key in results', async () => {
  const dir = path.join(process.env.TAMBOUILLE_RESULTS, report.campaign.id);
  const text = await Bun.file(path.join(dir, 'campaign.json')).text() + await Bun.file(path.join(dir, 'trials.jsonl')).text();
  expect(text).not.toContain('secret');
  expect(await fs.readdir(path.join(process.env.TAMBOUILLE_DATA, 'run', report.campaign.id, 'cache')).catch(() => [])).toEqual([]);
});
test('resuming plays nothing twice', async () => {
  const { runCampaign, campaignReport } = await import('../src/campaign.js');
  const { loadCampaign } = await import('../src/store.js');
  const { trials: _, probes: __, ...saved } = await loadCampaign(report.campaign.id);
  const before = report.campaign.trials.filter((t) => t.outcome !== 'infra').length;
  await runCampaign(saved, { log: () => {} });
  const after = (await campaignReport(saved.id)).campaign.trials.filter((t) => t.outcome !== 'infra').length;
  expect(after).toBe(before);
}, 60000);
