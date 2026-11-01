const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  node.append(...children.filter((c) => c != null));
  return node;
};
const api = async (route, body) => {
  const res = await fetch(`/api/${route}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await res.json();
  if (data?.error) throw new Error(data.error);
  return data;
};

const CATEGORIES = { research: 'Recherche', code: 'Code', terminal: 'Terminal et Git', writing: 'Rédaction', logic: 'Logique', math: 'Mathématiques', harness: 'Maîtrise du harnais', metacognition: 'Métacognition', rules: 'Règles', censorship: 'Censure' };
const PHASES = { floor: 'plancher', rules: 'règles', complex: 'complexes', censorship: 'censure', repeats: 'répétitions', contexts: 'contextes' };
const VERDICTS = { passed: 'Retenu', provisional: 'Provisoire', eliminated: 'Éliminé' };
const percent = (x) => (x == null ? '—' : `${Math.round(x * 100)} %`);
const seconds = (ms) => (ms == null ? '—' : ms < 60000 ? `${Math.round(ms / 1000)} s` : `${(ms / 60000).toFixed(1).replace('.', ',')} min`);
const gigas = (mb) => (mb == null ? '—' : `${(mb / 1024).toFixed(1).replace('.', ',')} Go`);
const duration = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${String(m % 60).padStart(2, '0')}` : ''}`);
const short = (id) => id.replace(/-(it|a\d+b)-.*$/, '');

const state = { overview: null, view: 'launch', selected: null };

// ---------- launch ----------
function renderIssues(issues) {
  const box = $('#issues');
  box.replaceChildren();
  if (!issues.length) return;
  box.append(el('div', { class: 'notice' },
    el('ul', {}, ...issues.map((i) => el('li', {}, i.text))),
    issues.some((i) => i.unload) ? el('button', { class: 'plain', onclick: async () => { await api('unload', {}); await refresh(); } }, 'Décharger') : null));
}

function renderForm(o) {
  $('#models').replaceChildren(...o.models.map((m) => el('label', { class: 'check' },
    el('input', { type: 'checkbox', name: 'model', value: m.id, checked: true, onchange: updateEstimate }), short(m.id), el('small', {}, `${(m.size / 1024 ** 3).toFixed(1).replace('.', ',')} Go`))));
  const present = [...new Set(o.tasks.map((t) => t.category))];
  $('#categories').replaceChildren(...present.map((c) => el('label', { class: 'check' },
    el('input', { type: 'checkbox', name: 'category', value: c, checked: true, onchange: updateEstimate }), CATEGORIES[c] ?? c, el('small', {}, String(o.tasks.filter((t) => t.category === c).length)))));
  $('#tasks').replaceChildren(...o.tasks.map((t) => el('label', { class: 'check' },
    el('input', { type: 'checkbox', name: 'task', value: t.id, onchange: updateEstimate }), t.id, el('small', {}, t.tier))));
  $('#budget').value = o.budgetMinutes;
  updateEstimate();
}

const selection = () => {
  const values = (name) => [...document.querySelectorAll(`input[name=${name}]:checked`)].map((i) => i.value);
  const categories = values('category');
  const allCategories = categories.length === document.querySelectorAll('input[name=category]').length;
  return { models: values('model'), categories: allCategories ? undefined : categories, ids: values('task'), budgetMinutes: Number($('#budget').value), reference: $('#reference').checked };
};

let estimateTurn = 0;
async function updateEstimate() {
  const s = selection();
  $('#budget-label').textContent = duration(s.budgetMinutes);
  const box = $('#estimate');
  const turn = ++estimateTurn;
  const noTasks = s.categories?.length === 0 && !s.ids.length;
  $('#run').disabled = !s.models.length || noTasks || Boolean(state.overview?.live.length) || Boolean(state.overview?.issues.length);
  if (!s.models.length || noTasks) return box.replaceChildren(el('p', { class: 'muted' }, 'Choisissez au moins un modèle et une évaluation.'));
  const r = await api('estimate', s);
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
    setTimeout(() => { refresh(); refreshLive(); }, 1500);
  } catch (e) {
    $('#run-error').textContent = e.message;
  }
});

// ---------- live ----------
const STATES = {
  pass: ['✓', 'Réussi'], fail: ['✗', 'Échoué'], violation: ['⛔', 'Violation'], infra: ['⚠', 'Panne'], skipped: ['–', 'Ignoré'],
  running: ['▶', 'En cours'], pending: ['·', 'À venir'],
};
const TOOLS = { list: 'Liste', read: 'Lecture', search: 'Recherche', write: 'Écriture', edit: 'Édition', run: 'Commande', web_search: 'Recherche web', fetch: 'Page web', plan: 'Plan', agent: 'Sous-agent', remember: 'Mémorise', forget: 'Oublie', recall: 'Rappel' };
const closedness = new Map(); // (what the user opened or closed survives the refresh)

const countRows = (rows) => {
  const n = { pass: 0, failed: 0, pending: 0 };
  for (const r of rows) {
    if (r.state === 'pass') n.pass++;
    else if (r.state === 'pending' || r.state === 'running') n.pending++;
    else n.failed++;
  }
  return n;
};
const countLine = (n) => `${n.pass} réussi${n.pass > 1 ? 's' : ''} · ${n.failed} échoué${n.failed > 1 ? 's' : ''} ou en panne · ${n.pending} restant${n.pending > 1 ? 's' : ''}`;

function renderActivity(m) {
  const row = m.rows.find((r) => r.key === m.running);
  const a = m.activity;
  return el('div', { class: 'activity' },
    el('div', { class: 'activity-head' }, el('strong', {}, `▶ ${row.task}`), el('span', { class: 'muted' }, ` ${CATEGORIES[row.category] ?? row.category} · essai ${row.rep} · ${row.numCtx} de contexte${m.currentSince ? ` · depuis ${seconds(Date.now() - m.currentSince)}` : ''}`)),
    a.context ? el('div', { class: 'muted' }, `Contexte utilisé : ${a.context.used} / ${a.context.numCtx}`) : null,
    a.steps.length ? el('ol', { class: 'steps' }, ...a.steps.map((s) => el('li', { class: s.ok === false ? 'failed' : null },
      s.kind === 'tool' ? el('b', {}, TOOLS[s.tool] ?? s.tool) : null, s.kind === 'answer' ? el('b', {}, 'Réponse') : null,
      ` ${s.text}`, s.ok === false ? ' ✗' : null))) : el('p', { class: 'muted' }, 'En attente de la première action du modèle…'),
    a.draft ? el('div', { class: 'draft' }, el('small', {}, a.draft.kind === 'thinking' ? 'Réflexion en cours' : 'Réponse en cours'), el('p', {}, a.draft.text)) : null);
}

function renderCategory(campaign, m, category, rows) {
  const id = `${campaign}/${m.id}/${category}`;
  const n = countRows(rows);
  const active = rows.some((r) => r.state === 'running');
  return el('details', { class: 'category', open: closedness.get(id) ?? active, ontoggle: (e) => closedness.set(id, e.target.open) },
    el('summary', {}, CATEGORIES[category] ?? category, el('small', {}, ` ${rows.length - n.pending} / ${rows.length}${n.failed ? ` · ${n.failed} ✗` : ''}`)),
    el('table', {}, el('tbody', {}, ...rows.map((r) => {
      const [icon, label] = STATES[r.state] ?? ['?', r.state];
      return el('tr', {},
        el('td', { class: `trial-${r.state}` }, `${icon} ${label}`),
        el('td', {}, `${r.task}${r.rep > 1 ? ` #${r.rep}` : ''}`, el('small', { class: 'muted' }, ` ${r.tier}`)),
        el('td', { class: 'num' }, seconds(r.durationMs)),
        el('td', { class: 'muted' }, [r.judge != null ? `juge ${percent(r.judge)}` : null, r.reason, r.detail].filter(Boolean).join(' · ')));
    }))));
}

function renderModel(campaign, m) {
  const n = countRows(m.rows);
  const finished = m.rows.length - n.pending;
  n.pending = Math.max(n.pending, m.total - finished); // (a campaign started before the plan was published only lists its mandatory trials)
  const categories = [...new Set(m.rows.map((r) => r.category))];
  const phase = !m.started ? 'en attente' : PHASES[m.phase] ?? m.phase;
  return el('div', { class: 'live-model' },
    el('div', { class: 'live-title' }, el('strong', {}, short(m.id)), el('span', { class: 'muted' }, ` ${finished} / ${m.total || '?'} · ${phase}`)),
    el('div', { class: 'progress' }, el('div', { style: `width:${m.total ? (finished / m.total) * 100 : 0}%` })),
    m.rows.length ? el('div', { class: 'muted' }, countLine(n)) : null,
    m.running ? renderActivity(m) : null,
    ...categories.map((c) => renderCategory(campaign, m, c, m.rows.filter((r) => r.category === c))));
}

function renderLive(live) {
  const box = $('#live');
  box.hidden = !live.length;
  box.replaceChildren(...live.map((c) => el('div', { class: 'card' },
    el('div', { class: 'live-head' }, el('h2', {}, `Campagne ${c.id}`), el('button', { class: 'plain', onclick: () => api('stop', {}) }, 'Arrêter (reprise possible)')),
    c.status !== 'running' ? el('p', {}, c.status) : null,
    ...c.models.map((m) => renderModel(c.id, m)))));
}

async function refreshLive() {
  renderLive(await api('progress').catch(() => []));
}

// ---------- report ----------
const tooltip = $('#tooltip');
function showTip(event, lines) {
  tooltip.replaceChildren(...lines.map((l, i) => (i ? el('div', {}, l) : el('strong', {}, l))));
  tooltip.hidden = false;
  tooltip.style.left = `${Math.min(event.clientX + 14, innerWidth - 230)}px`;
  tooltip.style.top = `${event.clientY + 14}px`;
}

/** Floor vs speed: one colour, each dot named, an eliminated model hollow. */
function tradeoffChart(ranking) {
  const points = ranking.filter((m) => m.summary.complexRate != null && m.summary.speed.medianSimpleMs != null);
  if (points.length < 2) return null;
  const NS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs, text) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    return n;
  };
  const W = 640; const H = 300; const L = 46; const B = 42; const T = 12; const R = 110;
  const maxX = Math.max(...points.map((m) => m.summary.speed.medianSimpleMs)) * 1.1;
  const x = (ms) => L + (ms / maxX) * (W - L - R);
  const y = (r) => T + (1 - r) * (H - T - B);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': 'Réussite sur les tâches complexes selon le temps médian d’une tâche simple' });
  for (const r of [0, 0.5, 1]) {
    svg.append(svgEl('line', { x1: L, x2: W - R, y1: y(r), y2: y(r), stroke: 'var(--grid)' }));
    svg.append(svgEl('text', { x: L - 8, y: y(r) + 4, 'text-anchor': 'end' }, percent(r)));
  }
  for (const k of [0, 0.5, 1]) svg.append(svgEl('text', { x: x(maxX * k), y: H - B + 18, 'text-anchor': 'middle' }, seconds(maxX * k)));
  svg.append(svgEl('text', { x: (L + W - R) / 2, y: H - 6, 'text-anchor': 'middle' }, 'Temps médian d’une tâche simple'));
  for (const m of points) {
    const px = x(m.summary.speed.medianSimpleMs);
    const py = y(m.summary.complexRate);
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

function rankingTable(ranking) {
  const rows = ranking.map((m, i) => {
    const s = m.summary;
    return el('tr', {},
      el('td', {}, `${i + 1}. ${short(m.model)}`, el('div', { class: 'muted' }, `${m.mainCtx ?? '—'} de contexte${m.reducedContext ? ' (réduit)' : ''}`)),
      el('td', { class: `verdict-${s.verdict}` }, `${s.verdict === 'eliminated' ? '✗ ' : s.verdict === 'passed' ? '✓ ' : '… '}${VERDICTS[s.verdict]}`, s.missing ? el('div', { class: 'muted' }, `${s.missing} essais manquants`) : null),
      el('td', { class: 'num' }, percent(s.simpleRate)),
      el('td', { class: 'num' }, percent(s.complexRate)),
      el('td', { class: 'num' }, seconds(s.speed.medianSimpleMs)),
      el('td', { class: 'num' }, s.speed.tps == null ? '—' : `${s.speed.tps} → ${s.speed.tpsLate ?? '—'}`),
      el('td', { class: 'num' }, gigas(s.memoryPeakMb)),
      el('td', { class: 'num' }, percent(s.censorship.refusalRate)));
  });
  return el('div', { class: 'card' }, el('h2', {}, 'Classement'),
    el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Modèle'), el('th', {}, 'Verdict'), ...['Simples', 'Complexes', 'Temps médian', 'Tokens/s', 'Mémoire', 'Refus'].map((h) => el('th', { class: 'num' }, h)))),
      el('tbody', {}, ...rows)),
    ...ranking.flatMap((m) => m.summary.reasons.map((r) => el('p', { class: 'verdict-eliminated' }, `✗ ${short(m.model)} : ${r}`))));
}

function toolsTable(ranking) {
  return el('div', { class: 'card' }, el('h2', {}, 'Usage des outils'), el('table', {},
    el('thead', {}, el('tr', {}, el('th', {}, 'Modèle'), ...['Appels', 'Appels ratés', 'Outils hallucinés', 'Outils oubliés', 'Alias corrigés', 'Boucles', 'Répétitions'].map((h) => el('th', { class: 'num' }, h)))),
    el('tbody', {}, ...ranking.map((m) => {
      const t = m.summary.tools;
      return el('tr', {}, el('td', {}, short(m.model)), ...[t.calls, t.failedCalls, t.inventedTools, t.forgottenTools, t.repairedAliases, t.loops, t.repeatedActions].map((v) => el('td', { class: 'num' }, String(v))));
    }))));
}

function metacognitionTable(ranking) {
  return el('div', { class: 'card' }, el('h2', {}, 'Métacognition : le bilan avant d’agir'), el('table', {},
    el('thead', {}, el('tr', {}, el('th', {}, 'Modèle'), ...['Sûr à tort', 'Doute à tort', 'Illisibles', 'Réponses directes', 'Réussite si direct', 'Réussite si vérifié', 'Réflexion médiane'].map((h) => el('th', { class: 'num' }, h)))),
    el('tbody', {}, ...ranking.map((m) => {
      const c = m.summary.metacognition;
      return el('tr', {}, el('td', {}, short(m.model)), ...[c.overconfident, c.underconfident + c.blind, c.unreadable, percent(c.directShare), percent(c.directSuccess), percent(c.lookupSuccess), c.thinkingChars == null ? '—' : `${c.thinkingChars} car.`].map((v) => el('td', { class: 'num' }, String(v))));
    }))));
}

function categoriesTable(ranking) {
  const cats = [...new Set(ranking.flatMap((m) => Object.keys(m.summary.byCategory)))];
  const cell = ([a, b]) => (b ? `${a}/${b}` : '—');
  return el('div', { class: 'card' }, el('h2', {}, 'Par catégorie (simples · complexes)'), el('table', {},
    el('thead', {}, el('tr', {}, el('th', {}, 'Modèle'), ...cats.map((c) => el('th', { class: 'num' }, CATEGORIES[c] ?? c)))),
    el('tbody', {}, ...ranking.map((m) => el('tr', {}, el('td', {}, short(m.model)), ...cats.map((c) => {
      const v = m.summary.byCategory[c];
      return el('td', { class: 'num' }, v ? `${cell(v.simple)} · ${cell(v.complex)}` : '—');
    }))))));
}

function contextsTable(ranking) {
  const sizes = [...new Set(ranking.flatMap((m) => m.probes.map((p) => p.numCtx)))].sort((a, b) => a - b);
  if (!sizes.length) return null;
  return el('div', { class: 'card' }, el('h2', {}, 'Contexte : harnais, mémoire et vitesse'), el('table', {},
    el('thead', {}, el('tr', {}, el('th', {}, 'Modèle'), ...sizes.map((n) => el('th', { class: 'num' }, n.toLocaleString('fr-FR'))))),
    el('tbody', {}, ...ranking.map((m) => el('tr', {}, el('td', {}, short(m.model)), ...sizes.map((n) => {
      const p = m.probes.find((x) => x.numCtx === n);
      const h = m.summary.contexts[n];
      if (!p?.fits) return el('td', { class: 'num verdict-eliminated' }, p ? 'ne tient pas' : '—');
      return el('td', { class: 'num' }, `${h ? `${h[0]}/${h[1]} · ` : ''}${gigas(p.memoryMb)} · ${p.tps ? Math.round(p.tps) : '—'} t/s`);
    }))))));
}

async function showReport(id) {
  state.selected = id;
  for (const b of document.querySelectorAll('.campaign')) b.classList.toggle('on', b.dataset.id === id);
  const { campaign, ranking } = await api(`report?id=${encodeURIComponent(id)}`);
  const f = campaign.fingerprint;
  $('#report').replaceChildren(
    el('p', { class: 'muted' }, `${f.machine.chip}, ${f.machine.memoryGb} Go · Poney ${f.poney.commit?.slice(0, 7)}${f.poney.dirty ? ' (modifié)' : ''} · moteur ${f.poney.engineBuild} · suite ${f.suite.label}${campaign.fullSuite ? '' : ' · suite partielle'}`),
    rankingTable(ranking), tradeoffChart(ranking) ?? '', categoriesTable(ranking), toolsTable(ranking), metacognitionTable(ranking), contextsTable(ranking) ?? '');
}

async function showHistory() {
  const list = await api('history');
  $('#campaigns').replaceChildren(...(list.length ? list.map((c) => el('button', { class: 'campaign', 'data-id': c.id, onclick: () => showReport(c.id) },
    c.id, el('small', {}, `${c.models.length} modèle${c.models.length > 1 ? 's' : ''} · ${c.trials} essais · ${c.status === 'finished' ? 'terminée' : c.status === 'stopped' ? 'arrêtée' : 'en cours'}${c.fullSuite ? '' : ' · partielle'}`))) : [el('p', { class: 'muted' }, 'Aucune campagne pour l’instant.')]));
  if (list.length) await showReport(state.selected ?? list[0].id);
  const options = list.map((c) => el('option', { value: c.id }, c.id));
  $('#compare-a').replaceChildren(...options.map((o) => o.cloneNode(true)));
  $('#compare-b').replaceChildren(...options);
  if (list.length > 1) $('#compare-b').value = list[1].id;
}

async function showComparison() {
  const a = $('#compare-a').value;
  const b = $('#compare-b').value;
  const box = $('#comparison');
  if (!a || !b) return box.replaceChildren(el('p', { class: 'muted' }, 'Il faut deux campagnes.'));
  const [c, ra, rb] = await Promise.all([api(`compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`), api(`report?id=${encodeURIComponent(a)}`), api(`report?id=${encodeURIComponent(b)}`)]);
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
for (const b of document.querySelectorAll('.sidebar button')) {
  b.addEventListener('click', async () => {
    for (const x of document.querySelectorAll('.sidebar button')) x.classList.toggle('on', x === b);
    for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== b.dataset.view;
    state.view = b.dataset.view;
    if (state.view !== 'launch') await showHistory();
    if (state.view === 'compare') await showComparison();
  });
}

async function refresh() {
  const o = await api('overview');
  const first = !state.overview;
  state.overview = o;
  renderIssues(o.issues);
  if (first) renderForm(o);
  else updateEstimate();
}
await refresh();
await refreshLive();
setInterval(refresh, 10000);
setInterval(refreshLive, 3000);
