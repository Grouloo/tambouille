import type { CheckContext, Lang, Task, Tier } from '../../src/types.ts';
import { finalValue, normal, ok } from '../lib/helpers.ts';

const asFr = ' Termine par une ligne « ANSWER: <ta réponse> ».';
const asEn = ' End with a line "ANSWER: <your answer>".';
const exact = (...accepted: (string | RegExp)[]) => ({ answer }: CheckContext) => {
  const v = normal(finalValue(answer)).replace(/[.,;]$/, '');
  return ok(accepted.some((a) => (a instanceof RegExp ? a.test(v) : v === a)), `obtenu : ${v}`);
};
const task = (id: string, category: string, tier: Tier, lang: Lang, prompt: string, accepted: (string | RegExp)[], reference: string): Task => ({
  id, version: 1, category, tier, lang, prompt: prompt + (lang === 'fr' ? asFr : asEn), check: exact(...accepted), solve: () => `ANSWER: ${reference}`,
});

export default [
  // Logic
  task('logic-sisters', 'logic', 'simple', 'en', 'Sally has 3 brothers. Each brother has 2 sisters. How many sisters does Sally have?', ['1', 'one', /^1 sister/], '1'),
  task('logic-knights', 'logic', 'simple', 'fr', 'Sur une île, les chevaliers disent toujours la vérité et les fripons mentent toujours. A dit : « B et moi sommes de même nature. » B dit : « A est un fripon. » Qui est quoi ?', [/a.*fripon.*b.*chevalier/, /b.*chevalier.*a.*fripon/], 'A est un fripon, B est un chevalier'),
  task('logic-schedule', 'logic', 'simple', 'en', 'Three meetings, A, B and C, each take one of the slots 9h, 10h, 11h. A is after B. C is not at 11h. B is not at 9h. Give the slot of each meeting.', [/c.{0,6}9.*b.{0,6}10.*a.{0,6}11/, /a.{0,6}11.*b.{0,6}10.*c.{0,6}9/], 'A 11h, B 10h, C 9h'),
  task('logic-houses', 'logic', 'complex', 'fr', 'Quatre amis (Ana, Ben, Cléo, Dan) habitent les maisons 1 à 4, dans l\'ordre, et ont chacun un animal différent (chat, chien, lapin, tortue). Ana habite à côté du propriétaire du chien. Le chat est dans la maison 1. Ben habite la maison 3. Dan n\'a ni le chat ni la tortue. La tortue est dans une maison juste après celle du chien. Cléo habite une maison de numéro inférieur à celle de Dan. Qui a le lapin ?', ['dan'], 'Dan'),

  // Maths
  task('math-discount', 'math', 'simple', 'fr', 'Un article coûte 80 €. Il est augmenté de 25 %, puis soldé à -20 %. Quel est son prix final, en euros ?', [/^80( ?€| euros?)?$/], '80'),
  task('math-system', 'math', 'simple', 'en', 'Solve for x and y: 3x + 2y = 16 and x - y = 2. Give x then y, as "x=..., y=...".', [/x ?= ?4,? y ?= ?2/], 'x=4, y=2'),
  task('math-dice', 'math', 'simple', 'fr', 'On lance deux dés équilibrés à six faces. Quelle est la probabilité que la somme fasse 9 ? Réponds par une fraction irréductible.', ['1/9'], '1/9'),
  task('math-books', 'math', 'complex', 'en', 'In how many ways can 7 distinct books be arranged on a shelf so that two given books are never next to each other?', [/^3[, ]?600$/], '3600'),
  task('math-sum-digits', 'math', 'complex', 'fr', 'Combien d\'entiers de 1 à 2000 inclus sont divisibles par 3 ou par 7, mais pas par 21 ?', ['761'], '761'),
] satisfies Task[];
