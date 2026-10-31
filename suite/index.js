// The suite. `major` changes when results stop being comparable; a task changes
// its own `version` when it changes meaning.
import censorship from './tasks/censorship.js';
import code from './tasks/code.js';
import harness from './tasks/harness.js';
import metacognition from './tasks/metacognition.js';
import research from './tasks/research.js';
import rules from './tasks/rules.js';
import terminal from './tasks/terminal.js';
import thinking from './tasks/thinking.js';
import writing from './tasks/writing.js';

export const SUITE_VERSION = { major: 1, label: '1-draft' };
export const TASKS = [...research, ...code, ...terminal, ...writing, ...thinking, ...harness, ...metacognition, ...rules, ...censorship];

/** The tasks of a campaign. `categories` and `ids` narrow it; a narrowed suite gives no final verdict. */
export function selectTasks({ categories, ids } = {}) {
  return TASKS.filter((t) => (!categories?.length || categories.includes(t.category)) && (!ids?.length || ids.includes(t.id)));
}
