// A campaign is a folder of results/: campaign.json (what ran, on what) and
// trials.jsonl, one line per finished trial, which is also how it resumes.
// Transcripts stay in .data: heavy, and private.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DATA, RESULTS } from './config.ts';
import type { Campaign, LoadedCampaign, RunRecord } from './types.ts';

/** Results are published: no paths of this machine in them, even in an error message. */
export const publicJson = (value: unknown, space?: number) => JSON.stringify(value, (key, v) => (key === 'file' ? undefined : v), space).replaceAll(os.homedir(), '~');

const dir = (id: string) => path.join(RESULTS, id);

export const newCampaignId = (d = new Date()) => d.toISOString().slice(0, 16).replace(/[:T]/g, '-');

/** Never that of an existing campaign: two starts in one minute would merge their trials. */
export async function freshCampaignId() {
  const base = newCampaignId();
  let id = base;
  for (let n = 2; await fs.stat(dir(id)).catch(() => null); n++) id = `${base}-${n}`;
  return id;
}

export async function saveCampaign(campaign: Campaign) {
  await fs.mkdir(dir(campaign.id), { recursive: true });
  await fs.writeFile(path.join(dir(campaign.id), 'campaign.json'), `${publicJson(campaign, 2)}\n`);
}

export async function appendRecord(id: string, record: RunRecord) {
  await fs.appendFile(path.join(dir(id), 'trials.jsonl'), `${publicJson(record)}\n`);
}

/** Rewrites the trials: a late judgement replaces the line of its trial. */
export async function saveRecords(id: string, records: RunRecord[]) {
  await fs.writeFile(path.join(dir(id), 'trials.jsonl'), records.map((r) => `${publicJson(r)}\n`).join(''));
}

export async function loadCampaign(id: string): Promise<LoadedCampaign> {
  const campaign = JSON.parse(await fs.readFile(path.join(dir(id), 'campaign.json'), 'utf8')) as Campaign;
  const raw = await fs.readFile(path.join(dir(id), 'trials.jsonl'), 'utf8').catch(() => '');
  const records = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as RunRecord);
  const name = (await fs.readFile(path.join(dir(id), 'name.txt'), 'utf8').catch(() => '')).trim();
  return { ...campaign, ...(name ? { name } : {}), trials: records.filter((r) => r.type === 'trial'), probes: records.filter((r) => r.type === 'probe') };
}

/** Apart from campaign.json, which a running campaign rewrites from its own copy. */
export async function renameCampaign(id: string, name: string) {
  await loadCampaign(id);
  const file = path.join(dir(id), 'name.txt');
  if (name.trim()) await fs.writeFile(file, `${name.trim().slice(0, 80)}\n`);
  else await fs.rm(file, { force: true });
}

/** Removes its results and everything kept for it in .data. For good. */
export async function deleteCampaign(id: string) {
  await loadCampaign(id);
  await Promise.all([dir(id), ...['transcripts', 'pending', 'run'].map((d) => path.join(DATA, d, id))].map((p) => fs.rm(p, { recursive: true, force: true })));
}

export async function listCampaigns() {
  const names = await fs.readdir(RESULTS).catch(() => []);
  const list: LoadedCampaign[] = [];
  for (const name of names.sort().reverse()) {
    if (await fs.stat(path.join(dir(name), 'campaign.json')).catch(() => null)) list.push(await loadCampaign(name));
  }
  return list;
}

export const transcriptPath = (id: string, key: string) => path.join(DATA, 'transcripts', id, `${key.replace(/[^\w.@#-]+/g, '_')}.ndjson`);
export const livePath = (id: string) => path.join(DATA, 'live', `${id}.json`);
