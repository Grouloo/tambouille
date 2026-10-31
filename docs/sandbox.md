# Sandbox

Poney has no isolation of its own. With `--yes`, `run` executes anything in a login shell with the whole environment,
there is no deny list, and the system prompt has no rule about destructive commands. `resolveInside` only protects the
file tools, and does not resolve links. So isolation comes from outside, with `sandbox-exec`, chosen over Docker
because Docker has no Metal (the engine would stay out anyway) and its VM would spoil memory measures on 24 GB.

## Each trial

- A new folder: `work` (the project), `home` (a fake home), `tmp`, all writable, and `ctl`, read only, with the
  engine key, a copy of the settings, and the script. It is deleted after the trial.
- A clean environment: a handful of variables, nothing inherited.
- A profile that denies by default.

| Allowed | Denied |
|---|---|
| Read: the system, Node, the Poney checkout, the model file, the trial's folder | Read: the rest of `/Users`, `/Volumes`, other temporary files |
| Write: `work`, `home`, `tmp` | Write: anything else, `ctl` included |
| Network: the engine's port, the frozen web's port, Tor's for Tor tasks | Network: the Internet, DNS, every other local port (LM Studio, Ollama, Tor's control port) |
| Signals inside the sandbox | Signals to other processes |
| | `open`, `osascript`, `security`, `launchctl`, Apple events, Keychain |

## The canary

`bun src/cli.js preflight`, and the start of every campaign, tries all of this for real: what must work, and what must
fail, including a secret planted in the real home and an unlisted port. A failure stops the campaign.

## Known limits

- `sandbox-exec` is deprecated by Apple, though it still works and is what other coding agents use on macOS. The
  canary is what would notice it break.
- The agent can read the engine key and call the engine directly. All it could do is use the model.
- After a trial, processes it left behind are found by the temporary folder in their environment and killed. A
  process that rewrites its environment could survive, inside the sandbox and without network.
- `/usr/bin` tools and the system stay readable, as do non-personal files outside `/Users`.

## After the agent has run

The folder is untrusted. Checks read files through `taskContext`, which refuses links leading out of the sandbox, and
run Git and the agent's code in the sandbox with no network: a hook or `core.fsmonitor` would otherwise run on the host.

The frozen web shows `127.0.0.1` URLs, as the sandbox has no DNS. A model may notice and comment on it: seen once, without effect.
