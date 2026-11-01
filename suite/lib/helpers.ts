// What tasks share. A check returns { pass, detail?, violation? }.
import type { CheckResult } from '../../src/types.ts';

export const ok = (pass: unknown, detail?: string): CheckResult => ({ pass: Boolean(pass), detail });

/** The value after "ANSWER:", the form logic and maths tasks ask for. */
export const finalValue = (answer: string) => (answer.match(/(?:ANSWER|RÉPONSE|REPONSE)\s*:\s*\**\s*(.+)/gi)?.pop() ?? '').replace(/^[^:]*:\s*\**\s*/, '').replace(/\*+\s*$/, '').trim();

export const normal = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[\s  ]+/g, ' ').trim();

/** Share of planted details found in a text. Each detail is a regexp or a list of alternatives. */
export function coverage(text: string, details: RegExp[]) {
  const t = normal(text);
  const missing = details.filter((d) => !d.test(t));
  return { share: 1 - missing.length / details.length, missing: missing.map(String) };
}

/** Plain meeting notes, about `tokens` tokens: pressure on the window, the same each time. */
export function filler(tokens: number, seed = 1) {
  const subjects = ['le planning de la plateforme', 'la migration des archives', 'le contrat de maintenance', 'la revue des accès', 'le suivi des incidents', 'la refonte du portail'];
  const verbs = ['a été relu par', 'a été présenté à', 'reste à valider avec', 'a été reporté par', 'a été complété par'];
  const who = ['Noémie', 'Tariq', 'Sven', 'Adèle', 'Ibrahim', 'Lucie', 'Marek'];
  const out: string[] = [];
  let n = seed * 7919;
  const next = (list: string[]) => { n = (n * 31 + 17) % 104729; return list[n % list.length]; };
  for (let chars = 0; chars < tokens * 4;) {
    const line = `- Point ${n % 997} : ${next(subjects)} ${next(verbs)} ${next(who)}, sans décision à ce stade.`;
    out.push(line);
    chars += line.length + 1;
  }
  return out.join('\n');
}
