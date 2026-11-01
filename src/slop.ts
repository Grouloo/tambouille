// Slop: what a model produces on autopilot. A second judgement, apart from whether the
// work is right: a task can pass and still be slop. 0 is crafted, 1 is pure slop.
import { judge } from './judge.ts';
import type { SlopKind, SlopResult } from './types.ts';

const SCALE = 'Score only the slop, not whether the content is correct. 0: specific, deliberate, written by someone who cared. 0.5: competent but generic in places. 1: pure autopilot output.';
const RUBRICS: Record<SlopKind, string> = {
  prose: `Grade the slop of this text. Slop: empty openers and closers, inflated or promotional wording, stock phrases ("it is important to note", "in today's fast-paced world"), reflexive triplets, "not X but Y" constructions, needless headers and bullets, em-dash mannerisms, restating the request, generic statements that fit any subject. ${SCALE}`,
  code: `Grade the slop of this code. Slop: comments that paraphrase the code, needless abstractions and wrappers, defensive checks for what cannot happen, generic names (data, result, handler, utils), dead code, broad catch blocks that hide errors, unrequested features, banners and decorative logging. ${SCALE}`,
  frontend: `Grade the slop of this front-end page. Slop: the default AI look (purple-blue gradients, gradient text, glassmorphism, emoji as icons, identical cards with rounded corners and soft shadows, centred hero with two buttons), invented testimonials or statistics, filler marketing copy, divs instead of semantic HTML, a design that ignores the brief's personality. ${SCALE}`,
};

export async function gradeSlop({ prompt, kind, text }: { prompt: string; kind: SlopKind; text: string }): Promise<SlopResult> {
  const v = await judge({ prompt, rubric: RUBRICS[kind], answer: text });
  return { model: v.model, score: Math.min(Math.max(v.score, 0), 1), reasons: v.reasons };
}
