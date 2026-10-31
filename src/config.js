// Where things are, and the numbers of the protocol. See docs/design.md.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dir, '..');
export const DATA = process.env.TAMBOUILLE_DATA ?? path.join(ROOT, '.data'); // transcripts, caches, engine copy: never versioned
export const RESULTS = process.env.TAMBOUILLE_RESULTS ?? path.join(ROOT, 'results'); // what is versioned
export const SUITE = path.join(ROOT, 'suite');

export const PONEY_DIR = process.env.PONEY_DIR ?? path.join(os.homedir(), 'Desktop', 'Exorel', 'local-codex');
export const PONEY_CLI = path.join(PONEY_DIR, 'src', 'cli.js');
export const APP_DATA = process.env.PONEY_APP_DATA ?? path.join(os.homedir(), 'Library', 'Application Support', 'poney');

/** Node, not Bun: Poney refuses Tor under Bun. */
export const NODE = process.env.PONEY_NODE ?? fs.realpathSync(execFileSync('/bin/zsh', ['-lc', 'command -v node'], { encoding: 'utf8' }).trim());

export const PROTOCOL = {
  budgetMinutes: 180, // per model
  trialMinutes: 15,
  simpleReps: 3,
  extraContexts: [16000, 64000], // beside the context of the settings, for the harness category and the probe
  probeMinutes: 3,
  referenceModel: 'gemma-4-12b', // prefix of the id: replayed when Poney changed
  judgeModel: 'claude-sonnet-5-5',
  pauseBetweenModelsSeconds: 300, // the MacBook Air has no fan
};

/** Used to plan until a model has measured durations of its own. */
export const EXPECTED_MINUTES = { simple: 4, complex: 12, rules: 5, censorship: 3, probe: 4 };
