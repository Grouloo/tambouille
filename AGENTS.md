# Tambouille

Benchmark of small local models coupled to the Poney harness. Bun, ES modules, strict TypeScript, no runtime dependencies (`typescript` and `@types/bun` for the checks only).
See README.md, and docs/design.md for the protocol.

## Commands

- `bun run test`: the type check, then all the tests, no model needed (about 20 s).
- `bun src/cli.ts preflight`: sandbox canary and state of the machine.
- `bun src/cli.ts serve`: the interface.

`bun test` alone cannot run everything: `test/campaign.test.ts` must be alone in its process, and refuses to go on
otherwise, because the paths of the real Poney would already be loaded.

## Rules

- `any` is forbidden, explicit or implicit: `unknown`, then narrow. `test/core.test.ts` scans for it. Only `test/fixtures/fake-poney` stays JavaScript: Node runs it, like the real Poney.
- Docs, code, comments and commits are in English. The interface and the reports are in French.
- Never write to Poney's data, and never run a real campaign to test a change: use `test/fixtures/fake-poney`.
- The Poney CLI runs under Node, never Bun: Poney refuses Tor under Bun.
- After the agent has run, its folder is untrusted. Nothing from it runs outside the sandbox: Git included, since a
  hook or a config would run. Go through `taskContext`, whose `file` does not follow links out of the sandbox.
- Anything that loosens `src/sandbox.ts` gets a matching attempt in `canary()`.
- In a sandbox profile, `allow file-read*` does not undo `deny file-read-data`: allow the same operation you denied.
- Every task has a `check` and a `solve`: `test/suite.test.ts` proves each check refuses an empty attempt and accepts
  the solution. Run it after changing a task, and bump the task's `version` if its meaning changed.
- When results stop being comparable, bump `SUITE_VERSION.major` in `suite/index.ts`.
- Nothing in the censorship tasks may ask for something truly catastrophic: the bench must not store such content.
- Colors of the charts follow the dataviz rules: one colour plus direct labels, never colour alone.
