// What the events of a run say about the way the model used the harness.
const TOOLS = new Set(['list', 'read', 'search', 'write', 'edit', 'run', 'web_search', 'fetch', 'plan', 'agent', 'remember', 'forget', 'recall']);
const SYNTAX = new Set(['old', 'new', 'reasoning', 'think', 'thinking', 'tool_call', 'tool_calls', 'function_call', 'arguments', 'parameter', 'args', 'path', 'content', 'command', 'query', 'pattern', 'url', 'title', 'task', 'tasks', 'body', 'start', 'end']);
const HTML = new Set('a abbr b body br button code div em footer form h1 h2 h3 h4 h5 h6 head header hr html i img input kbd label li main nav ol option p pre script section select small span strong style sub summary sup table tbody td textarea th thead title tr u ul'.split(' '));

/** Tag-shaped or JSON-shaped calls to tools that do not exist. Poney ignores them in silence. */
export function inventedTools(raw) {
  if (!raw) return [];
  const text = raw
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]*`/g, '')
    .replace(/<(write|edit|run)\b[^>]*>[\s\S]*?<\/\1>/g, '');
  const found = [];
  for (const m of text.matchAll(/<([a-z][a-z0-9_]*)(?:\s[^<>]*)?\/?>/g)) {
    const name = m[1];
    if (TOOLS.has(name) || SYNTAX.has(name) || HTML.has(name)) continue;
    if (name.includes('_') || m[0].endsWith('/>') || text.includes(`</${name}>`)) found.push(name);
  }
  for (const m of text.matchAll(/"name"\s*:\s*"([a-zA-Z_]+)"/g)) if (!TOOLS.has(m[1])) found.push(m[1]);
  for (const m of text.matchAll(/call:([a-zA-Z_]+)\{/g)) if (!TOOLS.has(m[1])) found.push(m[1]);
  return found;
}

/** Counters of a run, sub-agents included. */
export function analyzeEvents(events) {
  const c = { calls: 0, failedCalls: 0, inventedTools: 0, repairedAliases: 0, loops: 0, repeatedActions: 0, compactions: 0 };
  const used = {};
  const invented = [];
  let last = null;
  const open = new Map();
  for (const ev of events) {
    if (ev.type === 'action_start') {
      c.calls++;
      used[ev.tool] = (used[ev.tool] ?? 0) + 1;
      open.set(ev.id, ev.tool);
      if (ev.calledAs && !ev.calledAs.includes(':') && ev.calledAs !== ev.tool) c.repairedAliases++;
      const sig = JSON.stringify([ev.tool, ev.args]);
      if (sig === last) c.repeatedActions++;
      last = sig;
    } else if (ev.type === 'action_end') {
      if (ev.ok === false && open.get(ev.id) !== 'run') c.failedCalls++; // (a command that fails is a fact, not a bad call)
    } else if (ev.type === 'assistant_end') {
      for (const name of inventedTools(ev.rawText)) invented.push(name);
    } else if (ev.type === 'notice') {
      if (/boucle|répétait/.test(ev.text ?? '')) c.loops++;
    } else if (ev.type === 'compaction') {
      c.compactions++;
    }
  }
  c.inventedTools = invented.length;
  return { ...c, used, invented: [...new Set(invented)] };
}

/** The final answer of each turn of the main agent, and the replies in order. */
export function finalAnswers(events) {
  const answers = [];
  let current = '';
  for (const ev of events) {
    if (ev.agentId) continue;
    if (ev.type === 'assistant_end' && ev.text?.trim()) current = ev.text.trim();
    if (ev.type === 'turn_end') {
      answers.push(current);
      current = '';
    }
  }
  if (current) answers.push(current);
  return answers;
}

const FR = /\b(le|la|les|des|une|est|sont|dans|pour|avec|que|qui|pas|sur|nous|vous|cette|mais|aussi|être)\b/gi;
const EN = /\b(the|of|and|is|are|in|for|with|that|this|not|on|we|you|but|also|from|have|be)\b/gi;
/** 'fr', 'en', or null when there is too little text to tell. */
export function detectLanguage(text) {
  const prose = text.replace(/```[\s\S]*?```/g, ' ');
  const fr = prose.match(FR)?.length ?? 0;
  const en = prose.match(EN)?.length ?? 0;
  if (fr + en < 8) return null;
  return fr >= en ? 'fr' : 'en';
}

export function sumStats(events) {
  const ends = events.filter((e) => e.type === 'turn_end' && !e.agentId && e.stats);
  const firsts = events.filter((e) => e.type === 'assistant_end' && !e.agentId && e.stats);
  const sum = (k) => ends.reduce((n, e) => n + (e.stats[k] ?? 0), 0);
  const genMs = sum('genMs');
  return { steps: sum('steps'), tokens: sum('tokens'), genMs, promptMs: sum('promptMs'), tps: genMs ? Math.round((sum('tokens') / (genMs / 1000)) * 10) / 10 : null, firstTokenMs: firsts[0]?.stats.promptMs ?? null };
}
