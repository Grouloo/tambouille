#!/usr/bin/env node
// A stand-in for Poney's CLI: same arguments and events, no model. The behaviour comes from the task's text.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const argv = process.argv.slice(2);
const get = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
const say = (ev) => process.stdout.write(`${JSON.stringify(ev)}\n`);

if (argv[0] === 'version') { console.log(JSON.stringify({ commit: 'abc1234', dirty: false, engineBuild: 'fake', systemPromptHash: 'h' })); process.exit(0); }
if (argv[0] === 'models') { console.log(JSON.stringify([{ id: 'fake-model', file: process.env.FAKE_MODEL, size: 5, contextLength: 1000 }])); process.exit(0); }
if (argv[0] === 'engine-serve') {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ timings: { predicted_per_second: 42, prompt_ms: 10 } }));
  });
  server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'k', pid: process.pid, numCtx: Number(get('--num-ctx')), memory: 1024 ** 3, build: 'fake' })));
  process.on('SIGTERM', () => process.exit(0));
  await new Promise(() => {});
}

const messages = JSON.parse(fs.readFileSync(get('--script'), 'utf8'));
const cwd = get('--cwd');
const text = messages.join('\n');
say({ type: 'turn_start' });
const sure = /SURE/.test(text);
say({ type: 'notice', text: 'Bilan illisible : nouvel essai (2/3).' });
say({ type: 'triage', known: sure ? [{ point: 'x' }] : [], doubts: [], unknowns: sure ? [] : [{ point: 'y' }], route: sure ? 'direct' : 'investigate' });
say({ type: 'triage', update: true, known: [{ point: 'y' }], doubts: [], unknowns: [], route: 'direct' });
say({ type: 'action_start', id: 1, tool: 'write', args: { path: 'answer.txt' }, calledAs: 'write_file' });
fs.writeFileSync(path.join(cwd, 'answer.txt'), 'ok');
say({ type: 'action_end', id: 1, ok: true, output: 'ok' });
say({ type: 'action_start', id: 2, tool: 'read', args: { path: 'missing' } });
say({ type: 'action_end', id: 2, ok: false, output: 'no' });
if (/ESCAPE/.test(text)) {
  try { fs.writeFileSync(path.join(process.env.ESCAPE_TARGET ?? '/Users/Shared/tambouille-escape'), 'x'); say({ type: 'notice', text: 'escaped' }); } catch { say({ type: 'notice', text: 'blocked' }); }
}
if (/CRASH/.test(text)) { process.stderr.write('boom'); process.exit(1); }
if (/LOOP/.test(text)) { say({ type: 'turn_end', reason: 'loop', stats: null }); process.exit(3); }
if (/HANG/.test(text)) await new Promise(() => {});
say({ type: 'assistant_end', id: 3, text: /GOOD/.test(text) ? 'The answer is good and it is in the file, this is what you wanted for the task.' : 'bad', hasActions: false, rawText: 'text <magic_tool path="x" /> more', stats: { tps: 40, promptMs: 5 } });
say({ type: 'turn_end', reason: 'done', stats: { steps: 1, tokens: 10, genMs: 100, promptMs: 5 } });
