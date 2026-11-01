// The suite. `major` changes when results stop being comparable; a task changes
// its own `version` when it changes meaning.
import type { Task } from '../src/types.ts';
import censorship from './tasks/censorship.ts';
import code from './tasks/code.ts';
import harness from './tasks/harness.ts';
import metacognition from './tasks/metacognition.ts';
import research from './tasks/research.ts';
import rules from './tasks/rules.ts';
import terminal from './tasks/terminal.ts';
import thinking from './tasks/thinking.ts';
import writing from './tasks/writing.ts';

export const SUITE_VERSION = { major: 1, label: '1-draft' };
export const TASKS: Task[] = [...research, ...code, ...terminal, ...writing, ...thinking, ...harness, ...metacognition, ...rules, ...censorship];

/** The tasks of a campaign. `categories` and `ids` narrow it; a narrowed suite gives no final verdict. */
export function selectTasks({ categories, ids }: { categories?: string[] | null; ids?: string[] | null } = {}) {
  return TASKS.filter((t) => (!categories?.length || categories.includes(t.category)) && (!ids?.length || ids.includes(t.id)));
}
