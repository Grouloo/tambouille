import type { campaignReport } from '../campaign.ts';
import type { MachineIssue } from '../machine.ts';
import type { Progress, ProgressModel, Step, TranscriptEntry, TrialRow } from '../progress.ts';
import type { compare } from '../score.ts';
import type { ProbeRecord } from '../types.ts';

type Attrs = Record<string, string | number | boolean | null | undefined | ((event: Event) => void)>;
type Child = Node | string | null | undefined;
type Report = Awaited<ReturnType<typeof campaignReport>>;
type Ranked = Report['ranking'][number];
interface TaskInfo { id: string; category: string; tier: string; lang: string }
interface Overview { models: { id: string; size: number }[]; issues: MachineIssue[]; live: { id: string }[]; tasks: TaskInfo[]; numCtx: number; budgetMinutes: number }
interface Estimate { tasks: number; fullSuite: boolean; models: { model: string; played: number; total: number; counts: Record<string, number>; minutes: number; complete: boolean; mandatoryComplete: boolean; measured: boolean }[] }
interface HistoryItem { id: string; name?: string; status: string; models: string[]; fullSuite: boolean; trials: number }
interface Counts { pass: number; failed: number; pending: number }

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const all = <T extends HTMLElement = HTMLElement>(s: string, root: ParentNode = document) => [...root.querySelectorAll<T>(s)];
const el = (tag: string, attrs: Attrs = {}, ...children: Child[]) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = String(v ?? '');
    else if (typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, String(v));
  }
  node.append(...children.filter((c): c is Node | string => c != null));
  return node;
};
const api = async <T>(route: string, body?: unknown): Promise<T> => {
  const res = await fetch(`/api/${route}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = (await res.json()) as T & { error?: string };
  if (data?.error) throw new Error(data.error);
  return data;
};

const CATEGORIES: Record<string, string> = { research: 'Recherche', code: 'Code', terminal: 'Terminal et Git', writing: 'Rédaction', logic: 'Logique', math: 'Mathématiques', harness: 'Maîtrise du harnais', metacognition: 'Métacognition', rules: 'Règles', censorship: 'Censure' };
const PHASES: Record<string, string> = { floor: 'plancher', rules: 'règles', complex: 'complexes', censorship: 'censure', repeats: 'répétitions', contexts: 'contextes' };
const VERDICTS: Record<string, string> = { passed: 'Retenu', provisional: 'Provisoire', eliminated: 'Éliminé', unevaluated: 'Non évalué' };
const percent = (x: number | null | undefined) => (x == null ? '—' : `${Math.round(x * 100)} %`);
const seconds = (ms: number | null | undefined) => (ms == null ? '—' : ms < 60000 ? `${Math.round(ms / 1000)} s` : `${(ms / 60000).toFixed(1).replace('.', ',')} min`);
const gigas = (mb: number | null | undefined) => (mb == null ? '—' : `${(mb / 1024).toFixed(1).replace('.', ',')} Go`);
const duration = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${String(m % 60).padStart(2, '0')}` : ''}`);
const short = (id: string) => id.replace(/-(it|a\d+b)-.*$/, '');

const state: { renaming: string | null; overview: Overview | null; view: string; selected: string | null; live: string[]; page: Progress | null; panel: string | null; transcript: { key: string; task: string; running: boolean } | null } = { renaming: null, overview: null, view: 'launch', selected: null, live: [], page: null, panel: null, transcript: null };

// ---------- launch ----------
function renderIssues(issues: MachineIssue[]) {
  const box = $('#issues');
  box.replaceChildren();
  if (!issues.length) return;
  box.append(el('div', { class: 'notice' },
    el('ul', {}, ...issues.map((i) => el('li', {}, i.text))),
    issues.some((i) => i.unload) ? el('button', { class: 'plain', onclick: async () => { await api('unload', {}); await refresh(); } }, 'Décharger') : null));
}

function renderForm(o: Overview) {
  $('#models').replaceChildren(...o.models.map((m) => el('label', { class: 'check' },
    el('input', { type: 'checkbox', name: 'model', value: m.id, checked: true, onchange: updateEstimate }), short(m.id), el('small', {}, `${(m.size / 1024 ** 3).toFixed(1).replace('.', ',')} Go`))));
  const present = [...new Set(o.tasks.map((t) => t.category))];
  $('#categories').replaceChildren(...present.map((c) => el('label', { class: 'check' },
    el('input', { type: 'checkbox', name: 'category', value: c, checked: true, onchange: updateEstimate }), CATEGORIES[c] ?? c, el('small', {}, String(o.tasks.filter((t) => t.category === c).length)))));
  $('#tasks').replaceChildren(...o.tasks.map((t) => el('label', { class: 'check' },
    el('input', { type: 'checkbox', name: 'task', value: t.id, onchange: updateEstimate }), t.id, el('small', {}, t.tier))));
  $<HTMLInputElement>('#budget').value = String(o.budgetMinutes);
  updateEstimate();
}

const selection = () => {
  const values = (name: string) => all<HTMLInputElement>(`input[name=${name}]:checked`).map((i) => i.value);
  const categories = values('category');
  const allCategories = categories.length === document.querySelectorAll('input[name=category]').length;
  return { models: values('model'), categories: allCategories ? undefined : categories, ids: values('task'), budgetMinutes: Number($<HTMLInputElement>('#budget').value), reference: $<HTMLInputElement>('#reference').checked };
};

let estimateTurn = 0;
async function updateEstimate() {
  const s = selection();
  $('#budget-label').textContent = duration(s.budgetMinutes);
  const box = $('#estimate');
  const turn = ++estimateTurn;
  const noTasks = s.categories?.length === 0 && !s.ids.length;
  $<HTMLButtonElement>('#run').disabled = !s.models.length || noTasks || Boolean(state.overview?.live.length) || Boolean(state.overview?.issues.length);
  if (!s.models.length || noTasks) return box.replaceChildren(el('p', { class: 'muted' }, 'Choisissez au moins un modèle et une évaluation.'));
  const r = await api<Estimate>('estimate', s);
  if (turn !== estimateTurn) return;
  box.replaceChildren(el('table', {},
    el('thead', {}, el('tr', {}, ...['Modèle', 'Essais joués', 'Détail', 'Verdict possible'].map((h) => el('th', {}, h)))),
    el('tbody', {}, ...r.models.map((m) => el('tr', {},
      el('td', {}, short(m.model)),
      el('td', {}, `${m.played} sur ${m.total}${m.measured ? '' : ' (durées par défaut)'}`),
      el('td', { class: 'muted' }, Object.entries(m.counts).map(([k, v]) => `${PHASES[k]} ${v}`).join(', ') || 'rien ne tient'),
      el('td', {}, r.fullSuite && m.mandatoryComplete ? 'Définitif' : 'Provisoire'))))));
  return undefined;
}

$('#budget').addEventListener('input', updateEstimate);
$('#run').addEventListener('click', async () => {
  $('#run-error').textContent = '';
  try {
    await api('run', selection());
    setTimeout(async () => {
      await refresh();
      await refreshLive();
      if (state.live[0]) await openCampaign(state.live[0]);
    }, 1500);
  } catch (e) {
    $('#run-error').textContent = e instanceof Error ? e.message : String(e);
  }
});

// ---------- live ----------
const STATES: Record<string, [string, string]> = {
  pass: ['✓', 'Réussi'], fail: ['✗', 'Échoué'], violation: ['⛔', 'Violation'], infra: ['⚠', 'Panne'], skipped: ['–', 'Ignoré'],
  running: ['▶', 'En cours'], pending: ['·', 'À venir'],
};
const TOOLS: Record<string, string> = { list: 'Liste', read: 'Lecture', search: 'Recherche', write: 'Écriture', edit: 'Édition', run: 'Commande', web_search: 'Recherche web', fetch: 'Page web', plan: 'Plan', agent: 'Sous-agent', remember: 'Mémorise', forget: 'Oublie', recall: 'Rappel' };
const closedness = new Map<string, boolean>(); // (what the user opened or closed survives the refresh)

const countRows = (rows: TrialRow[]): Counts => {
  const n = { pass: 0, failed: 0, pending: 0 };
  for (const r of rows) {
    if (r.state === 'pass') n.pass++;
    else if (r.state === 'pending' || r.state === 'running') n.pending++;
    else n.failed++;
  }
  return n;
};
const countLine = (n: Counts) => `${n.pass} réussi${n.pass > 1 ? 's' : ''} · ${n.failed} échoué${n.failed > 1 ? 's' : ''} ou en panne · ${n.pending} restant${n.pending > 1 ? 's' : ''}`;

function renderActivity(m: ProgressModel) {
  const row = m.rows.find((r) => r.key === m.running);
  const a = m.activity;
  if (!row || !a) return null;
  return el('div', { class: 'activity' },
    el('div', { class: 'activity-head' }, el('strong', {}, `▶ ${row.task}`), el('span', { class: 'muted' }, ` ${CATEGORIES[row.category] ?? row.category} · essai ${row.rep} · ${row.numCtx} de contexte${m.currentSince ? ` · depuis ${seconds(Date.now() - m.currentSince)}` : ''}`)),
    a.context ? el('div', { class: 'muted' }, `Contexte utilisé : ${a.context.used} / ${a.context.numCtx}`) : null,
    a.steps.length ? el('ol', { class: 'steps' }, ...a.steps.map((s: Step) => el('li', { class: s.ok === false ? 'failed' : null },
      s.kind === 'tool' ? el('b', {}, TOOLS[s.tool ?? ''] ?? s.tool) : null, s.kind === 'answer' ? el('b', {}, 'Réponse') : null,
      ` ${s.text}`, s.ok === false ? ' ✗' : null))) : el('p', { class: 'muted' }, 'En attente de la première action du modèle…'),
    a.draft ? el('div', { class: 'draft' }, el('small', {}, a.draft.kind === 'thinking' ? 'Réflexion en cours' : 'Réponse en cours'), el('p', {}, a.draft.text)) : null);
}

function renderCategory(campaign: string, m: ProgressModel, category: string, rows: TrialRow[]) {
  const id = `${campaign}/${m.id}/${category}`;
  const n = countRows(rows);
  const active = rows.some((r) => r.state === 'running');
  return el('details', { class: 'category', open: closedness.get(id) ?? active, ontoggle: (e) => closedness.set(id, (e.target as HTMLDetailsElement).open) },
    el('summary', {}, CATEGORIES[category] ?? category, el('small', {}, ` ${rows.length - n.pending} / ${rows.length}${n.failed ? ` · ${n.failed} ✗` : ''}`)),
    el('table', {}, el('tbody', {}, ...rows.map((r) => {
      const [icon, label] = STATES[r.state] ?? ['?', r.state];
      return el('tr', {},
        el('td', { class: `trial-${r.state}` }, `${icon} ${label}`),
        el('td', {}, `${r.task}${r.rep > 1 ? ` #${r.rep}` : ''}`, el('small', { class: 'muted' }, ` ${r.tier}`)),
        el('td', { class: 'num' }, seconds(r.durationMs)),
        el('td', { class: 'muted' }, [r.judge != null ? `juge ${percent(r.judge)}` : null, r.slop != null ? `slop ${percent(r.slop)}` : null, r.reason, r.detail].filter(Boolean).join(' · ')),
        el('td', {}, r.state === 'pending' ? null : el('button', { class: 'plain small', onclick: () => openTranscript(r) }, 'Transcript')));
    }))));
}

const EVALUATIONS: Record<string, string> = { waiting: 'En attente', running: 'En cours', done: 'Terminée', interrupted: 'Interrompue' };
const remaining = (m: ProgressModel) => (m.remainingMs == null ? null : `≈ ${duration(Math.max(Math.ceil(m.remainingMs / 60000), 1))} restant${m.state === 'waiting' ? 'es au plus' : ''}`.replace('restantes au plus', 'au plus'));
const played = (m: ProgressModel) => m.rows.filter((r) => r.state !== 'pending' && r.state !== 'running').length;

function renderModelRow(m: ProgressModel) {
  const finished = played(m);
  return el('button', { class: `model-row${state.panel === m.id ? ' on' : ''}`, onclick: () => openPanel(m.id) },
    el('span', { class: 'model-name' }, short(m.id)),
    el('span', { class: `evaluation evaluation-${m.state}` }, EVALUATIONS[m.state]),
    el('span', { class: 'progress' }, el('span', { style: `width:${m.total ? (finished / m.total) * 100 : 0}%` })),
    el('span', { class: 'muted model-count' }, `${finished} / ${m.total || '?'}`),
    el('span', { class: 'muted model-left' }, remaining(m) ?? ''));
}

const ICON_PLAY = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12-7.5z"/></svg>';
const ICON_PAUSE = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg>';
const icon = (markup: string) => {
  const t = document.createElement('template');
  t.innerHTML = markup;
  return t.content.firstChild;
};

/** Swaps `node` for a field. Enter or leaving saves, Escape gives up. */
function startRename(node: HTMLElement, id: string, current: string) {
  if (state.renaming) return;
  state.renaming = id;
  const input = el('input', { class: 'rename', value: current, maxlength: 80, 'aria-label': 'Nom de la campagne' }) as HTMLInputElement;
  let done = false;
  const finish = async (save: boolean) => {
    if (done) return;
    done = true;
    if (save && input.value.trim() !== current) await api('rename', { id, name: input.value });
    state.renaming = null;
    input.replaceWith(node);
    await loadCampaigns();
    if (state.selected === id) renderCampaign(await api<Progress>(`campaign?id=${encodeURIComponent(id)}`));
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  node.replaceWith(input);
  input.focus();
  input.select();
}

async function resumeCampaign(id: string) {
  try {
    $('#campaign-error').textContent = '';
    await api('resume', { id });
    setTimeout(async () => {
      await refreshLive();
      await openCampaign(id);
    }, 1500);
  } catch (e) {
    $('#campaign-error').textContent = e instanceof Error ? e.message : String(e);
  }
}

function renderCampaign(c: Progress) {
  if (state.renaming) return;
  state.page = c;
  const when = (iso: string) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
  $('#campaign').replaceChildren(el('div', { class: 'card' },
    el('div', { class: 'live-head' }, el('h2', { title: 'Double-cliquer pour renommer', ondblclick: (e) => startRename(e.currentTarget as HTMLElement, c.id, c.name ?? '') }, c.name ?? `Campagne ${c.id}`),
      c.live ? el('button', { class: 'plain with-icon', title: 'Mettre en pause (reprise possible)', onclick: () => api('stop', {}) }, icon(ICON_PAUSE), 'Pause')
        : c.status !== 'finished' ? el('button', { class: 'plain with-icon', disabled: Boolean(state.overview?.issues.length), title: state.overview?.issues[0]?.text, onclick: () => resumeCampaign(c.id) }, icon(ICON_PLAY), 'Reprendre') : null),
    el('p', { class: 'muted' }, [`Démarrée le ${when(c.startedAt)}`, c.finishedAt ? `finie le ${when(c.finishedAt)}` : null, `${duration(c.budgetMinutes)} par modèle`, c.machine, `Poney ${c.poney}`, `suite ${c.suite}${c.fullSuite ? '' : ', partielle'}`].filter(Boolean).join(' · ')),
    c.live && c.status !== 'running' ? el('p', {}, c.status) : null,
    el('div', { class: 'model-list' }, ...c.models.map(renderModelRow))));
  renderPanel();
}

// ---------- side panel ----------
function showPanel(open: boolean) {
  document.body.classList.toggle('panel-open', open);
  $('#panel').inert = !open;
}
function closePanel() {
  state.panel = null;
  state.transcript = null;
  showPanel(false);
  if (state.page) renderCampaign(state.page);
}
function openPanel(id: string) {
  state.panel = id;
  state.transcript = null;
  if (state.page) renderCampaign(state.page);
}
function renderPanel() {
  const box = $('#panel');
  const page = state.page;
  const m = page?.models.find((x) => x.id === state.panel);
  showPanel(Boolean(m));
  if (!m || !page) return;
  if (state.transcript) {
    if (state.transcript.running) refreshTranscript();
    return;
  }
  const n = countRows(m.rows);
  n.pending = Math.max(n.pending, m.total - played(m));
  box.replaceChildren(...[
    el('div', { class: 'panel-head' }, el('h2', {}, short(m.id)), el('button', { class: 'plain', onclick: closePanel }, 'Fermer')),
    el('p', { class: 'muted' }, [EVALUATIONS[m.state], m.state === 'running' && m.phase ? PHASES[m.phase] ?? m.phase : null, remaining(m)].filter(Boolean).join(' · ')),
    m.rows.length ? el('p', { class: 'muted' }, countLine(n)) : null,
    m.running ? renderActivity(m) : null,
    ...[...new Set(m.rows.map((r) => r.category))].map((c) => renderCategory(page.id, m, c, m.rows.filter((r) => r.category === c))),
  ].filter((c): c is HTMLElement => c != null));
}

const entryView = (e: TranscriptEntry) => {
  if (e.kind === 'tool') {
    return el('details', { class: `entry${e.ok === false ? ' failed' : ''}` },
      el('summary', {}, el('b', {}, TOOLS[e.tool] ?? e.tool), ` ${Object.values(e.args).find((v): v is string => typeof v === 'string')?.slice(0, 100) ?? ''}${e.ok === false ? ' ✗' : ''}`),
      el('pre', {}, JSON.stringify(e.args, null, 2)), e.output ? el('pre', {}, e.output) : null);
  }
  if (e.kind === 'thinking') return el('details', { class: 'entry' }, el('summary', { class: 'muted' }, 'Réflexion'), el('pre', {}, e.text));
  if (e.kind === 'assessment') {
    const points = (l: { point?: string }[]) => l.map((p) => p.point ?? '').join(' ; ') || '—';
    return el('div', { class: 'entry muted' }, el('b', {}, 'Bilan '), `${e.route ?? '?'} · connu : ${points(e.known)} · doutes : ${points(e.doubts)} · inconnu : ${points(e.unknowns)}`);
  }
  if (e.kind === 'notice') return el('div', { class: 'entry muted' }, `⚠ ${e.text}`);
  return el('div', { class: 'entry' }, el('b', {}, e.kind === 'draft' ? 'En cours d’écriture' : 'Réponse'), el('pre', {}, e.text));
};

async function refreshTranscript() {
  const t = state.transcript;
  if (!t || !state.page || !state.panel) return;
  const { entries } = await api<{ entries: TranscriptEntry[] }>(`transcript?id=${encodeURIComponent(state.page.id)}&model=${encodeURIComponent(state.panel)}&key=${encodeURIComponent(t.key)}`);
  if (state.transcript !== t) return;
  const box = $('#panel');
  const open = new Set(all<HTMLDetailsElement>('details.entry', box).flatMap((d, i) => (d.open ? [i] : [])));
  box.replaceChildren(
    el('div', { class: 'panel-head' }, el('button', { class: 'plain', onclick: () => { state.transcript = null; renderPanel(); } }, '← Retour'), el('h2', {}, t.task), el('button', { class: 'plain', onclick: closePanel }, 'Fermer')),
    ...(entries.length ? entries.map(entryView) : [el('p', { class: 'muted' }, 'Aucun transcript pour cet essai.')]));
  all<HTMLDetailsElement>('details.entry', box).forEach((d, i) => { d.open = open.has(i); });
}
function openTranscript(r: TrialRow) {
  state.transcript = { key: r.key, task: r.task, running: r.state === 'running' };
  $('#panel').scrollTop = 0;
  refreshTranscript();
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.panel) closePanel(); });

async function refreshLive() {
  const live = await api<Progress[]>('progress').catch(() => null);
  if (!live) return;
  const before = state.live;
  state.live = live.map((c) => c.id);
  const shown = live.find((c) => c.id === state.selected);
  if (shown && state.view === 'history') renderCampaign(shown);
  if (state.live.join() === before.join()) return;
  await loadCampaigns();
  if (state.selected && before.includes(state.selected) && !state.live.includes(state.selected) && state.view === 'history') await openCampaign(state.selected); // (it just ended)
}

// ---------- report ----------
const tooltip = $('#tooltip');
function showTip(event: { clientX: number; clientY: number }, lines: string[]) {
  tooltip.replaceChildren(...lines.map((l, i) => (i ? el('div', {}, l) : el('strong', {}, l))));
  tooltip.hidden = false;
  tooltip.style.left = `${Math.min(event.clientX + 14, innerWidth - 230)}px`;
  tooltip.style.top = `${event.clientY + 14}px`;
}

/** Floor vs speed: one colour, each dot named, an eliminated model hollow. */
function tradeoffChart(ranking: Ranked[]) {
  const points = ranking.flatMap((m) => {
    const { complexRate } = m.summary;
    const { medianSimpleMs } = m.summary.speed;
    return complexRate != null && medianSimpleMs != null ? [{ ...m, complexRate, medianSimpleMs }] : [];
  });
  if (points.length < 2) return null;
  const NS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag: string, attrs: Record<string, string | number>, text?: string) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    if (text != null) n.textContent = text;
    return n;
  };
  const W = 640; const H = 300; const L = 46; const B = 42; const T = 12; const R = 110;
  const maxX = Math.max(...points.map((m) => m.medianSimpleMs)) * 1.1;
  const x = (ms: number) => L + (ms / maxX) * (W - L - R);
  const y = (r: number) => T + (1 - r) * (H - T - B);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': 'Réussite sur les tâches complexes selon le temps médian d’une tâche simple' });
  for (const r of [0, 0.5, 1]) {
    svg.append(svgEl('line', { x1: L, x2: W - R, y1: y(r), y2: y(r), stroke: 'var(--grid)' }));
    svg.append(svgEl('text', { x: L - 8, y: y(r) + 4, 'text-anchor': 'end' }, percent(r)));
  }
  for (const k of [0, 0.5, 1]) svg.append(svgEl('text', { x: x(maxX * k), y: H - B + 18, 'text-anchor': 'middle' }, seconds(maxX * k)));
  svg.append(svgEl('text', { x: (L + W - R) / 2, y: H - 6, 'text-anchor': 'middle' }, 'Temps médian d’une tâche simple'));
  for (const m of points) {
    const px = x(m.medianSimpleMs);
    const py = y(m.complexRate);
    const out = m.summary.verdict === 'eliminated';
    svg.append(svgEl('circle', { cx: px, cy: py, r: 5, fill: out ? 'none' : 'var(--accent)', stroke: 'var(--accent)', 'stroke-width': 2 }));
    svg.append(svgEl('text', { x: px + 10, y: py + 4, class: 'label' }, short(m.model)));
    const hit = svgEl('circle', { cx: px, cy: py, r: 14, fill: 'transparent', tabindex: 0 });
    const lines = [short(m.model), `${percent(m.summary.complexRate)} sur les tâches complexes`, `${seconds(m.summary.speed.medianSimpleMs)} par tâche simple`, VERDICTS[m.summary.verdict]];
    hit.addEventListener('pointermove', (e) => showTip(e, lines));
    hit.addEventListener('pointerleave', () => { tooltip.hidden = true; });
    svg.append(hit);
  }
  return el('div', { class: 'card' }, el('h2', {}, 'Qualité et temps'), svg);
}

function rankingTable(ranking: Ranked[]) {
  const rows = ranking.map((m, i) => {
    const s = m.summary;
    return el('tr', {},
      el('td', {}, `${i + 1}. ${short(m.model)}`, el('div', { class: 'muted' }, `${m.mainCtx ?? '—'} de contexte${m.reducedContext ? ' (réduit)' : ''}`)),
      el('td', { class: `verdict-${s.verdict}` }, `${s.verdict === 'eliminated' ? '✗ ' : s.verdict === 'passed' ? '✓ ' : s.verdict === 'unevaluated' ? '– ' : '… '}${VERDICTS[s.verdict]}`, s.missing ? el('div', { class: 'muted' }, `${s.missing} essais manquants`) : null),
      el('td', { class: 'num' }, percent(s.simpleRate)),
      el('td', { class: 'num' }, percent(s.complexRate)),
      el('td', { class: 'num' }, percent(s.slopRate)),
      el('td', { class: 'num' }, seconds(s.speed.medianSimpleMs)),
      el('td', { class: 'num' }, s.speed.firstTokenMs == null ? '—' : `${(s.speed.firstTokenMs / 1000).toFixed(1).replace('.', ',')} s`),
      el('td', { class: 'num' }, s.speed.tps == null ? '—' : `${s.speed.tps} → ${s.speed.tpsLate ?? '—'}`),
      el('td', { class: 'num' }, gigas(s.memoryPeakMb)),
      el('td', { class: 'num' }, percent(s.censorship.refusalRate)));
  });
  return el('div', { class: 'card' }, el('h2', {}, 'Classement'),
    el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Modèle'), el('th', {}, 'Verdict'), ...['Simples', 'Complexes', 'Slop', 'Temps médian', 'Premier token', 'Tokens/s', 'Mémoire', 'Refus'].map((h) => el('th', { class: 'num' }, h)))),
      el('tbody', {}, ...rows)),
    ...ranking.flatMap((m) => m.summary.reasons.map((r) => el('p', { class: 'verdict-eliminated' }, `✗ ${short(m.model)} : ${r}`))));
}

function toolsTable(ranking: Ranked[]) {
  return el('div', { class: 'card' }, el('h2', {}, 'Usage des outils'), el('table', {},
    el('thead', {}, el('tr', {}, el('th', {}, 'Modèle'), ...['Appels', 'Appels ratés', 'Outils hallucinés', 'Outils oubliés', 'Alias corrigés', 'Boucles', 'Répétitions'].map((h) => el('th', { class: 'num' }, h)))),
    el('tbody', {}, ...ranking.map((m) => {
      const t = m.summary.tools;
      return el('tr', {}, el('td', {}, short(m.model)), ...[t.calls, t.failedCalls, t.inventedTools, t.forgottenTools, t.repairedAliases, t.loops, t.repeatedActions].map((v) => el('td', { class: 'num' }, String(v))));
    }))));
}

function metacognitionTable(ranking: Ranked[]) {
  return el('div', { class: 'card' }, el('h2', {}, 'Métacognition : le bilan avant d’agir'), el('table', {},
    el('thead', {}, el('tr', {}, el('th', {}, 'Modèle'), ...['Sûr à tort', 'Doute à tort', 'Illisibles', 'Réponses directes', 'Réussite si direct', 'Réussite si vérifié', 'Réflexion médiane'].map((h) => el('th', { class: 'num' }, h)))),
    el('tbody', {}, ...ranking.map((m) => {
      const c = m.summary.metacognition;
      return el('tr', {}, el('td', {}, short(m.model)), ...[c.overconfident, c.underconfident + c.blind, c.unreadable, percent(c.directShare), percent(c.directSuccess), percent(c.lookupSuccess), c.thinkingChars == null ? '—' : `${c.thinkingChars} car.`].map((v) => el('td', { class: 'num' }, String(v))));
    }))));
}

function categoriesTable(ranking: Ranked[]) {
  const cats = [...new Set(ranking.flatMap((m) => Object.keys(m.summary.byCategory)))];
  const cell = ([a, b]: [number, number]) => (b ? `${a}/${b}` : '—');
  return el('div', { class: 'card' }, el('h2', {}, 'Par catégorie (simples · complexes)'), el('table', {},
    el('thead', {}, el('tr', {}, el('th', {}, 'Modèle'), ...cats.map((c) => el('th', { class: 'num' }, CATEGORIES[c] ?? c)))),
    el('tbody', {}, ...ranking.map((m) => el('tr', {}, el('td', {}, short(m.model)), ...cats.map((c) => {
      const v = m.summary.byCategory[c];
      return el('td', { class: 'num' }, v ? `${cell(v.simple)} · ${cell(v.complex)}` : '—');
    }))))));
}

function contextsTable(ranking: Ranked[]) {
  const sizes = [...new Set(ranking.flatMap((m) => m.probes.map((p) => p.numCtx)))].sort((a, b) => a - b);
  if (!sizes.length) return null;
  return el('div', { class: 'card' }, el('h2', {}, 'Contexte : harnais, mémoire et vitesse'), el('table', {},
    el('thead', {}, el('tr', {}, el('th', {}, 'Modèle'), ...sizes.map((n) => el('th', { class: 'num' }, n.toLocaleString('fr-FR'))))),
    el('tbody', {}, ...ranking.map((m) => el('tr', {}, el('td', {}, short(m.model)), ...sizes.map((n) => {
      const p = m.probes.find((x: ProbeRecord) => x.numCtx === n);
      const h = m.summary.contexts[n];
      if (!p?.fits) return el('td', { class: 'num verdict-eliminated' }, p ? 'ne tient pas' : '—');
      return el('td', { class: 'num' }, `${h ? `${h[0]}/${h[1]} · ` : ''}${gigas(p.memoryMb)} · ${p.tps ? Math.round(p.tps) : '—'} t/s`);
    }))))));
}

async function showReport(id: string) {
  state.selected = id;
  for (const b of all('.campaign')) b.classList.toggle('on', b.dataset.id === id);
  const { ranking } = await api<Report>(`report?id=${encodeURIComponent(id)}`);
  $('#report').replaceChildren(
    rankingTable(ranking), tradeoffChart(ranking) ?? '', categoriesTable(ranking), toolsTable(ranking), metacognitionTable(ranking), contextsTable(ranking) ?? '');
}

const campaignStatus = (c: HistoryItem) => (state.live.includes(c.id) ? 'en cours' : c.status === 'finished' ? 'terminée' : c.status === 'stopped' ? 'en pause' : 'interrompue');

async function loadCampaigns() {
  if (state.renaming) return;
  const list = await api<HistoryItem[]>('history');
  const live = (c: HistoryItem) => (state.live.includes(c.id) ? 0 : 1);
  const sorted = list.map((c, i) => ({ c, i })).sort((a, b) => live(a.c) - live(b.c) || a.i - b.i).map(({ c }) => c);
  $('#campaigns').replaceChildren(...(sorted.length ? sorted.map((c) => el('button', { class: `campaign${c.id === state.selected && state.view === 'history' ? ' on' : ''}`, 'data-id': c.id, onclick: () => openCampaign(c.id), ondblclick: (e) => startRename(e.currentTarget as HTMLElement, c.id, c.name ?? '') },
    el('span', { class: 'campaign-id' }, c.name ?? c.id, state.live.includes(c.id) ? el('span', { class: 'spinner', 'aria-hidden': 'true' }) : null),
    el('small', {}, `${c.models.length} modèle${c.models.length > 1 ? 's' : ''} · ${c.trials} essais · ${campaignStatus(c)}${c.fullSuite ? '' : ' · partielle'}`))) : [el('p', { class: 'muted' }, 'Aucune campagne pour l’instant.')]));
  if ($<HTMLSelectElement>('#compare-a').options.length === list.length) return;
  const options = list.map((c) => el('option', { value: c.id }, c.id));
  $('#compare-a').replaceChildren(...options.map((o) => o.cloneNode(true)));
  $('#compare-b').replaceChildren(...options);
  if (list.length > 1) $<HTMLSelectElement>('#compare-b').value = list[1]?.id ?? '';
}

async function openCampaign(id: string) {
  const changed = state.selected !== id && state.view === 'history';
  if (state.selected !== id) closePanel();
  state.selected = id;
  openView('history');
  if (changed && !matchMedia('(prefers-reduced-motion: reduce)').matches) $('#history').animate(PAGE_IN, { duration: 220, easing: 'ease-out' });
  renderCampaign(await api<Progress>(`campaign?id=${encodeURIComponent(id)}`));
  if (state.live.includes(id)) $('#report').replaceChildren();
  else await showReport(id);
}

async function showComparison() {
  const a = $<HTMLSelectElement>('#compare-a').value;
  const b = $<HTMLSelectElement>('#compare-b').value;
  const box = $('#comparison');
  if (!a || !b) return box.replaceChildren(el('p', { class: 'muted' }, 'Il faut deux campagnes.'));
  const [c, ra, rb] = await Promise.all([api<ReturnType<typeof compare>>(`compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`), api<Report>(`report?id=${encodeURIComponent(a)}`), api<Report>(`report?id=${encodeURIComponent(b)}`)]);
  box.replaceChildren(
    ...c.warnings.map((w) => el('div', { class: 'notice' }, w)),
    el('div', { class: 'card' }, el('h2', {}, `${c.commonTasks} tâches communes`),
      el('table', {}, el('tbody', {},
        el('tr', {}, el('td', {}, a), el('td', { class: 'num' }, percent(c.a))),
        el('tr', {}, el('td', {}, b), el('td', { class: 'num' }, percent(c.b)))))),
    rankingTable(ra.ranking), rankingTable(rb.ranking));
  return undefined;
}
$('#compare-a').addEventListener('change', showComparison);
$('#compare-b').addEventListener('change', showComparison);

// ---------- views ----------
const PAGE_IN = [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }];
function openView(view: string) {
  state.view = view;
  for (const b of all('.links button')) b.classList.toggle('on', b.dataset.view === view);
  for (const v of all('.view')) v.hidden = v.id !== view;
  for (const b of all('.campaign')) b.classList.toggle('on', view === 'history' && b.dataset.id === state.selected);
}
for (const b of all('.links button')) {
  b.addEventListener('click', async () => {
    closePanel();
    openView(b.dataset.view ?? 'launch');
    if (state.view === 'compare') await showComparison();
  });
}

async function refresh() {
  const o = await api<Overview>('overview');
  const first = !state.overview;
  state.overview = o;
  renderIssues(o.issues);
  if (first) renderForm(o);
  else updateEstimate();
}
await refresh();
await loadCampaigns();
await refreshLive();
setInterval(() => { refresh(); loadCampaigns(); }, 10000);
setInterval(refreshLive, 3000);
