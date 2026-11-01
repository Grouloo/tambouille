import type { Task } from '../../src/types.ts';
import { coverage, ok } from '../lib/helpers.ts';

const SHORT = [
  'Je prépare le déménagement de notre bureau de Nantes. On a retenu le prestataire Trans-Loire, devis de 14 750 € TTC, signé par Inès Morvan mardi.',
  'Côté dates : le déménagement est fixé au 18 mars, mais le serveur de fichiers doit être coupé la veille à 19 h. Rémi s\'en charge.',
  'Le bail de l\'ancien local se termine le 31 mars et l\'état des lieux est le 2 avril à 10 h. Attention, la caution de 6 200 € ne revient que si la moquette de la salle B est remplacée.',
  'Point ouvert : on ne sait pas encore qui récupère les 12 écrans en trop, l\'association Emmaüs n\'a pas répondu.',
  'Fais-moi une synthèse de tout ça pour Inès, qui part en congé demain et doit pouvoir reprendre le dossier à son retour sans rien relire.',
];
const SHORT_DETAILS = [/trans-loire/, /14[ .,]?750/, /morvan|ines/, /18 mars/, /19 ?h/, /remi/, /31 mars/, /2 avril/, /6[ .,]?200/, /moquette/, /12 ecrans/, /emmaus/];

const LONG = [
  'We\'re planning the Orbis billing migration. Current system is Zuora, contract ends 30 June. Target is Stripe Billing. Priya Raman owns the project.',
  'Budget approved by finance: 86,000 EUR, with a 10% contingency that needs Karim\'s sign-off.',
  'Pour les données, il y a 41 300 abonnés actifs. On migre par vagues : 5 % d\'abord, puis 30 %, puis le reste.',
  'First wave is scheduled for 12 May, on the Benelux customers.',
  'Le risque principal : les 2 700 abonnements en devise CHF, que Stripe traite différemment chez nous à cause de l\'entité suisse. Personne n\'a encore validé la TVA suisse.',
  'Decision from today\'s call: we keep invoices numbered in the old series until the end of the fiscal year, because of the auditor, Hélène Dubreuil.',
  'Update: first wave moved to 19 May, the Benelux tax mapping isn\'t ready. 12 May is dead.',
  'Rollback plan: a full export every night to S3, kept 90 days. Omar writes the restore script.',
  'Support a demandé un gel des tarifs pendant les vagues. Accepté, sauf pour l\'offre Enterprise.',
  'Update on budget: Karim approved using the contingency, so we now have 94,600 EUR in total.',
  'Open questions: who validates the Swiss VAT, and do we notify customers by email or in-app? Nobody has decided.',
  'Peux-tu me faire une synthèse complète, en français, pour le comité de direction ? Ils n\'ont suivi aucun de ces échanges et doivent savoir où on en est, ce qui est décidé et ce qui reste ouvert.',
];
const LONG_DETAILS = [/zuora/, /30 (juin|june)/, /stripe/, /priya|raman/, /94[ .,]?600/, /41[ .,]?300/, /5 ?%/, /30 ?%/, /19 mai/, /benelux/, /2[ .,]?700/, /chf|suisse/, /tva/, /dubreuil|auditeur/, /90 jours/, /omar/, /enterprise/, /e-?mail|in-app/];

const DRAFT = `Le comité a examiné trois options pour le parc de vélos municipal. L'option A, l'extension des stations
existantes, coûte 1,2 M€ et couvre 60 % de la demande. L'option B, un service en free-floating, coûte 0,7 M€ et couvre
45 % de la demande, mais impose un contrat de 8 ans. L'option C, mixte, coûte 1,5 M€ et couvre 80 %. Le comité recommande
l'option C, sous réserve d'une subvention régionale de 400 000 €, qui sera connue en septembre.
`;

export default [
  {
    id: 'writing-reschedule-email', version: 1, category: 'writing', tier: 'simple', lang: 'fr', slop: { kind: 'prose' },
    prompt: 'Écris à Mme Keller un mail court et poli pour décaler notre rendez-vous de jeudi 14 h à vendredi 10 h, parce que notre intervenant est malade. 80 mots maximum, avec un objet.',
    judge: { rubric: 'A polite, natural business email in French. It must state both the old and the new time and the reason, with a subject line, and not sound robotic. 1 if all is there and it reads well, 0.5 if clumsy, 0 if something is missing.', threshold: 0.7 },
    check: ({ answer }) => ok(/jeudi/i.test(answer) && /vendredi/i.test(answer) && /objet/i.test(answer) && answer.split(/\s+/).length <= 110, `${answer.split(/\s+/).length} mots`),
    solve: () => 'Objet : Décalage de notre rendez-vous\n\nBonjour Madame Keller,\n\nNotre intervenant est malade : pourrions-nous décaler notre rendez-vous de jeudi 14 h à vendredi 10 h ? Merci de votre compréhension.\n\nCordialement,',
  },
  {
    id: 'writing-summary-file', version: 1, category: 'writing', tier: 'simple', lang: 'en', slop: { kind: 'prose', files: ['summary.md'] },
    prompt: 'Read comite.txt and write summary.md in English: three bullet points for a decision maker, keeping every figure that matters.',
    setup: ({ write }) => write('comite.txt', DRAFT),
    check: async ({ file }) => {
      const text = (await file('summary.md')) ?? '';
      const { share, missing } = coverage(text, [/1[.,]5/, /80 ?%/, /400[ ,.]?000|0[.,]4/, /september/, /option c|mixed/]);
      return ok(share === 1 && (text.match(/^\s*[-*•]/gm) ?? []).length === 3, `manque : ${missing}`);
    },
    solve: async ({ write }) => { await write('summary.md', '- The committee recommends option C (mixed).\n- It costs €1.5M and covers 80% of demand.\n- It depends on a €400,000 regional grant, known in September.\n'); return 'Done.'; },
  },
  {
    id: 'writing-synthesis-short', version: 1, category: 'writing', tier: 'simple', lang: 'fr', messages: SHORT, expectedMinutes: 6, slop: { kind: 'prose' },
    judge: { rubric: 'A synthesis of a conversation for someone who will not read it. Good: conclusion first, what is decided, what remains open, the conditions attached (the deposit depends on the carpet), the deadlines. Bad: goes fast, stays on the surface, restates messages one by one, drops conditions. 1 thorough and usable as is, 0.5 mostly there but shallow, 0 surface only.', threshold: 0.7 },
    check: ({ answer }) => { const { share, missing } = coverage(answer, SHORT_DETAILS); return ok(share >= 0.85, `détails ${Math.round(share * 100)} %, manque : ${missing}`); },
    solve: () => 'Trans-Loire, devis 14 750 € signé par Inès Morvan. Déménagement le 18 mars, serveur coupé la veille à 19 h par Rémi. Bail fini le 31 mars, état des lieux le 2 avril. Caution de 6 200 € liée à la moquette. Ouvert : les 12 écrans, Emmaüs sans réponse.',
  },
  {
    id: 'writing-synthesis-long', version: 1, category: 'writing', tier: 'complex', lang: 'fr', messages: LONG, expectedMinutes: 14, slop: { kind: 'prose' },
    judge: { rubric: 'A synthesis for an executive committee who followed nothing. It must use the latest values (first wave 19 May, not 12 May; budget 94,600 EUR, not 86,000), separate what is decided from what is open, name the Swiss VAT risk and why it matters, and keep the conditions (price freeze except Enterprise, invoice numbering until the end of the fiscal year because of the auditor). 1 thorough, faithful and well organised; 0.5 correct but shallow; 0 misses the updates or stays on the surface.', threshold: 0.7 },
    check: ({ answer }) => {
      const { share, missing } = coverage(answer, LONG_DETAILS);
      const stale = /12 mai/i.test(answer) && !/(remplac|décal|report|initial|ancien|abandon)/i.test(answer);
      return ok(share >= 0.8 && !stale, `détails ${Math.round(share * 100)} %, manque : ${missing}`);
    },
    solve: () => 'Migration de Zuora (fin le 30 juin) vers Stripe, pilotée par Priya Raman. Budget 94 600 EUR. 41 300 abonnés, par vagues de 5 %, 30 %, puis le reste, à partir du 19 mai sur le Benelux. Risque : 2 700 abonnements CHF et TVA suisse. Facturation conservée à la demande de l\'auditrice Dubreuil. Export S3 gardé 90 jours, script par Omar. Gel des tarifs sauf Enterprise. Ouvert : qui valide la TVA, et e-mail ou in-app.',
  },
] satisfies Task[];
