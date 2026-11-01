import type { Task } from '../../src/types.ts';
import { filler, ok } from '../lib/helpers.ts';

const pressure = (numCtx: number, count = 8, share = 0.17) => Array.from({ length: count }, (_, i) => `Voici le compte rendu n° ${i + 1}, à garder pour plus tard. Réponds juste « OK ».\n\n${filler(Math.round(numCtx * share), i + 1)}`);

export default [
  {
    id: 'harness-search-first', version: 1, category: 'harness', tier: 'simple', lang: 'en', expects: { tools: [['search']] },
    prompt: 'Which constant sets the retry budget in this project, in which file, and what is its value?',
    setup: async ({ write }) => {
      for (let i = 0; i < 60; i++) await write(`src/mod${i}/service_${i}.py`, `# Service ${i}\nTIMEOUT_${i} = ${i * 3}\n\ndef handler_${i}(x):\n    return x + ${i}\n`);
      await write('src/mod37/limits.py', 'MAX_RETRY_BUDGET = 37\n');
    },
    check: ({ answer }) => ok(/MAX_RETRY_BUDGET/.test(answer) && /\b37\b/.test(answer) && /limits\.py/.test(answer)),
    solve: () => 'MAX_RETRY_BUDGET = 37, in src/mod37/limits.py.',
  },
  {
    id: 'harness-read-range', version: 1, category: 'harness', tier: 'simple', lang: 'fr', expects: { tools: [['read']], readWindow: true },
    prompt: 'Donne le code d\'erreur exact écrit à la ligne 2417 de journal.log.',
    setup: ({ write }) => write('journal.log', Array.from({ length: 3000 }, (_, i) => `${i + 1} INFO ${i + 1 === 2417 ? 'ERR-7Q3X-90' : `ok-${(i * 7919) % 9973}`}`).join('\n')),
    check: ({ answer }) => ok(/ERR-7Q3X-90/.test(answer)),
    solve: () => 'ERR-7Q3X-90',
  },
  {
    id: 'harness-remember-constraint', version: 1, category: 'harness', tier: 'simple', lang: 'fr', expects: { tools: [['remember']] }, expectedMinutes: 6,
    messages: [
      'Pour tout ce projet, le client final est la société Brisemer, le budget plafond est de 18 400 € et rien ne doit être livré avant le 9 juin. C\'est important pour la suite de la conversation.',
      'Quelle est la différence entre un devis et une facture ? Une phrase.',
      'Propose un nom pour un outil interne de suivi de tickets.',
      'Je prépare le mail de lancement : à qui est-il adressé, quel budget maximum je peux annoncer, et à partir de quand on peut livrer ?',
    ],
    check: ({ answer }) => ok(/Brisemer/i.test(answer) && /18[ .,  ]?400/.test(answer) && /9 juin/.test(answer)),
    solve: () => 'Brisemer, 18 400 €, pas avant le 9 juin.',
  },
  {
    id: 'harness-recall-after-compaction', version: 1, category: 'harness', tier: 'complex', lang: 'fr', expects: { tools: [['recall', 'remember']], compaction: true }, expectedMinutes: 15, trialMinutes: 30,
    messages: ({ numCtx }) => [
      'Le port du service de facturation en préproduction est 48213, le compte de service est svc-ledger-7, et Maelle a dit de ne jamais relancer le job du dimanche. J\'y reviendrai.',
      ...pressure(numCtx),
      'Rappelle-moi le port de préproduction, le compte de service, et ce que Maelle a interdit.',
    ],
    check: ({ answer }) => ok(/48213/.test(answer) && /svc-ledger-7/.test(answer) && /dimanche/i.test(answer)),
    solve: () => '48213, svc-ledger-7, ne jamais relancer le job du dimanche.',
  },
  {
    id: 'harness-work-after-compaction', version: 1, category: 'harness', tier: 'complex', lang: 'en', expects: { tools: [['recall', 'remember']], compaction: true }, expectedMinutes: 15, trialMinutes: 30,
    messages: ({ numCtx }) => [
      'House rules for this repo, for the whole conversation: every new module must start with the line `# owner: team-hydra`, and functions must be named in the form `hydra_<verb>`.',
      ...pressure(numCtx),
      'Now create tools/cleanup.py with one function that removes empty strings from a list. Follow the house rules I gave you at the start.',
    ],
    check: async ({ file }) => {
      const text = (await file('tools/cleanup.py')) ?? '';
      return ok(text.startsWith('# owner: team-hydra') && /def hydra_[a-z_]+\(/.test(text), text.slice(0, 120));
    },
    solve: async ({ write }) => { await write('tools/cleanup.py', '# owner: team-hydra\n\ndef hydra_clean(items):\n    return [i for i in items if i]\n'); return 'Done.'; },
  },
] satisfies Task[];
