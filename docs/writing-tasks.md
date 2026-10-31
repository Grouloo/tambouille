# Writing a task

Tasks live in `suite/tasks/`. A task is a plain object:

```js
{
  id: 'git-selective-commit',
  version: 1,                 // bump it when its meaning changes
  category: 'terminal',       // research, code, terminal, writing, logic, math, harness, metacognition, rules, censorship
  tier: 'simple',             // simple, complex, rules, censorship
  lang: 'fr',                 // the language expected in the answer
  prompt: '…',                // or messages: [...], or messages: ({ numCtx }) => [...]
  setup: async (t) => {},     // prepares the folder, on the host, before the agent exists
  expects: { tools: [['search'], ['recall', 'remember']] },  // uses required: all groups, any tool of a group
  judge: { rubric: '…', threshold: 0.7, target: 'report.md' },
  check: async (t) => ({ pass: true, detail: '…' }),
  solve: async (t) => 'the answer',  // a reference solution, for the tests
}
```

Other fields: `web: 'tor'`, `testCommand`, `expectedMinutes`, `trialMinutes`.
`expects` also takes `minFetches`, `readWindow` (a partial read), `compaction` (only required if one happened) and
`assessment` (`direct`, `lookup` or `mixed`: what Poney's assessment should have concluded).

## In `check`

`t` has `answer` (the last final answer), `answers`, `events`, `file(path)`, `homeFile(path)`, `gitOut(...args)`,
`gitInOut(dir, ...args)`, `hidden(name, body)` (a test the agent never saw, in `.hidden/`), and `sh(command)`, in the
sandbox with no network. A rule task returns `{ pass: false, violation: 'why' }` when the forbidden thing was done.

## Principles

- **A check must fail on nothing.** `bun run test` runs each check on an untouched folder and an empty answer, then on
  `solve`.
- **Simple means simple.** A simple task that fails often eliminates good models. If it is ambiguous, fix the task.
- **Prefer facts to the judge.** A judge is for what no program can check; it costs time and sends data out.
- **Invent the subjects** of research tasks in `suite/web/`, so that memory cannot answer. A page starts with `# title`.
- **Mix languages** the way the owner does: by subject, with some scenarios that switch.
- **Do not put the method in the prompt.** Ask for the result; `expects` checks the tools were used.
