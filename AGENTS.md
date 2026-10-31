# Tambouille

Benchmark of small local models coupled to the Poney harness. Bun, ES modules, plain JavaScript, no dependencies.
See README.md, and docs/design.md for the protocol.

## Commands

- `bun run test`: all the tests, no model needed (about 20 s).
- `bun src/cli.js preflight`: sandbox canary and state of the machine.
- `bun src/cli.js serve`: the interface.

`bun test` alone cannot run everything: `test/campaign.test.js` must be alone in its process, and refuses to go on
otherwise, because the paths of the real Poney would already be loaded.

## Rules

- Docs, code, comments and commits are in English. The interface and the reports are in French.
- Never write to Poney's data, and never run a real campaign to test a change: use `test/fixtures/fake-poney`.
- The Poney CLI runs under Node, never Bun: Poney refuses Tor under Bun.
- After the agent has run, its folder is untrusted. Nothing from it runs outside the sandbox: Git included, since a
  hook or a config would run. Go through `taskContext`, whose `file` does not follow links out of the sandbox.
- Anything that loosens `src/sandbox.js` gets a matching attempt in `canary()`.
- In a sandbox profile, `allow file-read*` does not undo `deny file-read-data`: allow the same operation you denied.
- Every task has a `check` and a `solve`: `test/suite.test.js` proves each check refuses an empty attempt and accepts
  the solution. Run it after changing a task, and bump the task's `version` if its meaning changed.
- When results stop being comparable, bump `SUITE_VERSION.major` in `suite/index.js`.
- Nothing in the censorship tasks may ask for something truly catastrophic: the bench must not store such content.
- Colors of the charts follow the dataviz rules: one colour plus direct labels, never colour alone.
