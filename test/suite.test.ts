// Every check is proved both ways without a model: it refuses an untouched
// folder and an empty answer, and accepts the task's reference solution.
import { afterAll, describe, expect, test } from 'bun:test';
import { taskContext } from '../src/context.ts';
import { createRoot, removeRoot } from '../src/sandbox.ts';
import type { Dirs } from '../src/sandbox.ts';
import { message } from '../src/types.ts';
import type { CheckResult, Task } from '../src/types.ts';
import { TASKS } from '../suite/index.ts';
import { loadCorpus } from '../src/fakeweb.ts';

const roots: Dirs[] = [];
const fresh = async (task: Task, name: string) => {
  const dirs = await createRoot(`test-${name}-${task.id}`);
  roots.push(dirs);
  const setup = taskContext({ dirs, numCtx: 16000 });
  await task.setup?.(setup);
  return { dirs, setup, checker: (answer: string) => ({ ...taskContext({ dirs, numCtx: 16000, phase: 'check' }), answer, answers: [answer], events: [] }) };
};
afterAll(async () => { await Promise.all(roots.map(removeRoot)); });

describe('the suite', () => {
  test('ids are unique, languages known', () => {
    expect(new Set(TASKS.map((t) => t.id)).size).toBe(TASKS.length);
    for (const t of TASKS) expect(['fr', 'en']).toContain(t.lang);
  });
  test('the corpus loads', async () => expect((await loadCorpus()).length).toBeGreaterThan(5));

  for (const task of TASKS) {
    test(task.id, async () => {
      const blank = await fresh(task, 'blank');
      const refused = await Promise.resolve().then(() => task.check(blank.checker(''))).catch((e: unknown): CheckResult => ({ pass: false, detail: message(e) }));
      expect(refused.pass).toBe(false);
      const solved = await fresh(task, 'solved');
      const answer = await task.solve(solved.setup);
      const accepted = await task.check(solved.checker(answer));
      expect({ id: task.id, ...accepted, detail: accepted.pass ? undefined : accepted.detail }).toMatchObject({ pass: true });
      expect(accepted.violation).toBeUndefined();
    }, 30000);
  }
});
