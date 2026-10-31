import { ok } from '../lib/helpers.js';

const webRead = { tools: [['web_search'], ['fetch']] };
export default [
  {
    id: 'research-kestrel-battery', version: 1, category: 'research', tier: 'simple', lang: 'fr', expects: webRead,
    prompt: 'Quelle est la capacité de la batterie du vélo cargo Kestrel V3 ? Cherche sur le web et donne ta source.',
    check: ({ answer }) => ok(/612\s*Wh/i.test(answer), 'attendu : 612 Wh'),
    solve: () => '612 Wh, selon la fiche technique officielle du Kestrel V3.',
  },
  {
    id: 'research-harlow-reopening', version: 1, category: 'research', tier: 'simple', lang: 'en', expects: webRead,
    prompt: 'Look up the Harlow Ferry tramway on the web. When was it electrified, when did it reopen, and who led the campaign?',
    check: ({ answer }) => ok(/1931/.test(answer) && /2009/.test(answer) && /Tennant/.test(answer)),
    solve: () => 'It was electrified in 1931 and reopened in 2009 after a campaign led by Maud Tennant.',
  },
  {
    id: 'research-quillon-deprecation', version: 1, category: 'research', tier: 'simple', lang: 'en', expects: webRead,
    prompt: 'In the quillon library, in which version was the `retry` option deprecated, and what replaces it? Check the web.',
    check: ({ answer }) => ok(/4\.2\.0/.test(answer) && /backoff/.test(answer)),
    solve: () => '`retry` was deprecated in 4.2.0; use `backoff`.',
  },
  {
    id: 'research-vassenne-report', version: 1, category: 'research', tier: 'complex', lang: 'fr',
    expects: { tools: [['web_search'], ['fetch']], minFetches: 3 },
    prompt: 'Le niveau de nitrates du lac de Vassenne dépasse-t-il la limite ? Fais une recherche web, lis plusieurs sources, et écris ta conclusion dans rapport.md : chiffres, source de chacun, points de désaccord, et ce qu\'on peut en conclure. Attention aux sources faibles ou corrigées.',
    judge: { rubric: 'The report must say that the corrected annual mean is 41 mg/L (not 38), below the 50 mg/L limit; that the 52 mg/L figure is a single June sample at the north outlet, so not comparable; that the "doubled" press claim has no data. Score 1 if all three are clear and sourced, 0.5 if one is missing or muddled, 0 otherwise. Depth counts: a shallow list of numbers without explanation of why they differ scores at most 0.5.', threshold: 0.7, target: 'rapport.md' },
    check: async ({ file }) => {
      const text = (await file('rapport.md')) ?? '';
      return ok(/\b41\b/.test(text) && /\b52\b/.test(text) && /rectifi|corrig/i.test(text), 'attendu : 41 mg/L corrigé, 52 mg/L situé');
    },
    solve: async ({ write }) => { await write('rapport.md', '# Rapport\nMoyenne corrigée par rectificatif : 41 mg/L, sous la limite de 50. Le 52 mg/L est un prélèvement unique en juin. Le doublement de la presse est sans source.\n'); return 'Écrit dans rapport.md.'; },
  },
];
