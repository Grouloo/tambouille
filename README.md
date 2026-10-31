# Tambouille

A benchmark for small local LLMs **coupled to the [Poney](https://github.com/Grouloo/poney) harness**, on one given
machine. It does not rate a model on its own: it finds the best trade-off between intelligence, speed, memory and
context among the models Poney can run here, and keeps the results so that a new model can be compared with old ones.

The bench prefers a high floor to a high ceiling: a model that never stumbles on simple tasks beats a brilliant
but erratic one.

```bash
bun src/cli.js serve              # the local interface, on http://127.0.0.1:4177
bun src/cli.js preflight          # is the sandbox holding, is the machine free?
bun src/cli.js run --budget 1h    # a campaign, on every model
bun src/cli.js report             # the ranking of the latest campaign
bun run test                      # no model needed
```

## Requirements

- macOS, for `sandbox-exec` and Metal. [Bun](https://bun.sh), and Node for the Poney CLI (Poney refuses Tor under Bun).
- A Poney checkout at commit `6fb8bb5` or later, in `~/Desktop/Exorel/local-codex` or at `PONEY_DIR`.
- The Poney engine installed by the app (the bench copies it, and never downloads it).
- `claude`, logged in, to judge what a program cannot check. **Outputs of the judged tasks are sent to Anthropic.**
- Optional: Tor on port 9050 or 9150, for four censorship tasks, which are skipped otherwise.

## What a campaign does

For each model Poney can run (GGUF only: results from other servers would measure their cache and prompt, not Poney's):

1. **Canary**: real escape attempts prove the sandbox holds, or the campaign does not start.
2. **Machine check**: on mains power, no model loaded elsewhere. Nothing is unloaded without being asked.
3. **Probe**: load time, speed and memory at 16k, 32k and 64k of context.
4. **Trials**, in order, until the budget runs out: simple tasks once, rules, complex tasks, censorship, repetitions
   of simple tasks, harness tasks at the other context sizes.
5. **Verdict**: a gate, then a ranking.

A campaign can be stopped and resumed, runs in its own process, and keeps the Mac awake.

| Verdict | Meaning |
|---|---|
| Passed | Mandatory trials all played, gate passed |
| Provisional | Gate not failed so far, but trials are missing, unjudged, or the suite was narrowed |
| Eliminated | Final: at most one isolated failure per category was allowed, no task may fail twice, no rule may be broken |

Passed models rank by success on complex tasks. Close rates (within 5 points) are settled by the use of tools, then
by time. Speed, memory, context and refusals are shown beside the ranking rather than blended into a score.

## Commands

```
models                     the models Poney can run
preflight                  sandbox canary and state of the machine
unload                     unloads the models held by other apps
plan [selection]           what a budget would play, without running
run [selection]            starts a campaign
resume ID                  goes on with an interrupted campaign
rejudge ID                 judges what the judge could not reach
report [ID]                the ranking of a campaign (default: the latest)
compare ID_A ID_B          two campaigns, on their common tasks
serve [--port 4177]        the local interface

Selection: --models a,b  --categories code,terminal  --tasks id,id  --budget 1h30  --reference
```

## Where things are

- `src/`: the bench. `campaign.js` is the loop, `trial.js` one trial, `sandbox.js` the isolation, `score.js` the verdicts.
- `src/ui/`: the interface, in French like Poney's.
- `suite/`: the tasks, and `suite/web/`, the frozen web of the research tasks.
- `results/`: one folder per campaign, versioned. `.data/`: transcripts, engine copy, caches, not versioned.
- `docs/design.md`: the protocol and why. `docs/sandbox.md`: what is isolated, and what is not.
  `docs/writing-tasks.md`: how to add a task.

## Your Poney install stays as it is

The bench reads `settings.json` once, without its API key, and works on a copy. It uses its own copy of the engine
(at launch the app kills whatever names its own engine folder), its own prompt cache, and never writes to the app's data.
