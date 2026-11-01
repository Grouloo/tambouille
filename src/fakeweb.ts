// The frozen web: a local stand-in for SearXNG (`/search?format=json&q=`) and its
// pages (`/p/<slug>`), served from suite/web. Same answers every year.
import fs from 'node:fs/promises';
import path from 'node:path';
import { SUITE } from './config.ts';

interface Page { slug: string; title: string; body: string }

const words = (s: string): string[] => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').match(/[\p{L}\p{N}]{2,}/gu) ?? [];

export async function loadCorpus(dir = path.join(SUITE, 'web')) {
  const pages: Page[] = [];
  for (const name of (await fs.readdir(dir)).sort()) {
    if (!name.endsWith('.md')) continue;
    const raw = await fs.readFile(path.join(dir, name), 'utf8');
    const [, title, body] = raw.match(/^# (.+)\n([\s\S]*)$/) ?? [];
    if (!title || body === undefined) throw new Error(`${name}: a page starts with "# title"`);
    pages.push({ slug: name.slice(0, -3), title, body: body.trim() });
  }
  return pages;
}

export function search(pages: Page[], query: string) {
  const wanted = new Set(words(query));
  return pages
    .map((p) => {
      const inTitle = new Set(words(p.title));
      const inBody = new Set(words(p.body));
      let score = 0;
      for (const w of wanted) score += (inTitle.has(w) ? 3 : 0) + (inBody.has(w) ? 1 : 0);
      return { p, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.p.slug.localeCompare(b.p.slug))
    .slice(0, 6)
    .map((r) => r.p);
}

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const escape = (s: string) => s.replace(/[&<>]/g, (c) => ENTITIES[c] ?? c);

export async function startFakeWeb() {
  const pages = await loadCorpus();
  const server: Bun.Server<undefined> = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req): Response {
      const url = new URL(req.url);
      if (url.pathname === '/search') {
        const results = search(pages, url.searchParams.get('q') ?? '').map((p) => ({ title: p.title, url: `http://127.0.0.1:${server.port}/p/${p.slug}`, content: p.body.replace(/\s+/g, ' ').slice(0, 200) }));
        return Response.json({ results });
      }
      const page = pages.find((p) => url.pathname === `/p/${p.slug}`);
      if (!page) return new Response('Not found', { status: 404 });
      return new Response(`<html><head><title>${escape(page.title)}</title></head><body><h1>${escape(page.title)}</h1><pre>${escape(page.body)}</pre></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, port: server.port ?? 0, stop: () => server.stop(true) };
}
