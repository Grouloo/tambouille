// The shapes shared by the bench, the suite and the interface.
import type { TaskContext } from './context.ts';

export type Tier = 'simple' | 'complex' | 'rules' | 'censorship';
export type Lang = 'fr' | 'en';
export type Outcome = 'pass' | 'fail' | 'violation' | 'infra' | 'skipped' | 'invalid' | 'unjudged';
export type Verdict = 'passed' | 'provisional' | 'eliminated' | 'unevaluated';
export type Phase = 'floor' | 'rules' | 'complex' | 'censorship' | 'repeats' | 'contexts';
export type Route = 'direct' | 'lookup' | 'mixed';
export type Miss = 'overconfident' | 'underconfident' | 'blind' | 'unreadable';

/** One line of `--json`. Poney adds fields freely: only what the bench reads is named. */
export interface AgentEvent {
  type: string;
  id?: string | number;
  agentId?: string | number;
  tool?: string;
  args?: Record<string, unknown>;
  calledAs?: string;
  ok?: boolean;
  output?: string;
  text?: string;
  kind?: string;
  thinking?: string;
  rawText?: string;
  hasActions?: boolean;
  reason?: string;
  route?: string;
  update?: boolean;
  failed?: boolean;
  known?: AssessmentPoint[];
  doubts?: AssessmentPoint[];
  unknowns?: AssessmentPoint[];
  used?: number;
  numCtx?: number;
  stats?: Record<string, number> | null;
}
export interface AssessmentPoint { point?: string; why?: string }

export interface CheckResult { pass: boolean; detail?: string; violation?: string }
export interface CheckContext extends TaskContext { answer: string; answers: string[]; events: AgentEvent[] }
export interface Expects { tools?: string[][]; minFetches?: number; readWindow?: boolean; compaction?: boolean; assessment?: string }
export type SlopKind = 'prose' | 'code' | 'frontend';
export interface SlopResult { model: string; score: number; reasons: string }
export interface TaskJudge { rubric: string; threshold?: number; censorship?: boolean; target?: string }

export interface Task {
  id: string;
  version: number;
  category: string;
  tier: Tier;
  lang: Lang;
  lastLang?: Lang;
  prompt?: string;
  messages?: string[] | ((options: { numCtx: number }) => string[]);
  web?: string;
  expects?: Expects;
  judge?: TaskJudge;
  slop?: { kind: SlopKind; files?: string[] };
  testCommand?: string;
  trialMinutes?: number;
  expectedMinutes?: number;
  setup?: (ctx: TaskContext) => unknown;
  check: (ctx: CheckContext) => CheckResult | Promise<CheckResult>;
  solve: (ctx: TaskContext) => string | Promise<string>;
}

export interface PlanEntry { task: Task; rep: number; numCtx: number; phase: Phase; mandatory: boolean }

export interface ToolCounters { calls: number; failedCalls: number; inventedTools: number; repairedAliases: number; loops: number; repeatedActions: number; compactions: number }
export interface ToolUse extends ToolCounters { used: Record<string, number>; invented: string[] }
export interface Assessment { route: string | null | undefined; known: number; doubts: number; unknowns: number; updates: number; unreadable: number; retries: number; thinkingChars: number }
export interface TrialStats { steps: number; tokens: number; genMs: number; promptMs: number; tps: number | null; firstTokenMs: number | null }
export interface JudgeResult { model: string; score: number; level: string | null; reasons: string }

export interface TrialRecord {
  type: 'trial';
  key: string; at: string; task: string; taskVersion: number; category: string; tier: Tier; lang: Lang;
  model: string; numCtx: number; rep: number; phase: Phase; primary: boolean;
  outcome: Outcome;
  reason?: string; detail?: string; durationMs?: number; exit?: number | null; memoryPeakMb?: number | null; thermal?: number;
  stats?: TrialStats; tools?: ToolUse; assessment?: Assessment | null; assessmentMiss?: Miss | null;
  forgotten?: string[]; language?: { expected: string; got: string | null; ok: boolean | null };
  judge?: JudgeResult; slop?: SlopResult; slopPending?: boolean; censorship?: 'refused' | 'partial' | 'answered';
  events?: AgentEvent[];
}

export interface ProbeRecord {
  type: 'probe';
  at: string; model: string; numCtx: number; fits: boolean;
  error?: string; loadMs?: number; tps?: number | null; firstTokenMs?: number | null; memoryMb?: number | null; estimatedMb?: number;
  pressure?: { level: number; swapMb: number | null };
}
export type RunRecord = TrialRecord | ProbeRecord;

export interface PoneyModel { id: string; file?: string; size: number }
export interface CampaignModel extends PoneyModel { sha256: string; planned?: string[]; mainCtx?: number | null; reducedContext?: boolean }
export interface Fingerprint {
  machine: { model: string | null; chip: string | null; memoryGb: number; os: string; bun: string };
  poney: { commit?: string; dirty?: boolean; engineBuild: string; systemPromptHash?: string };
  suite: { major: number; label: string; hash: string };
  settings: string;
  judge: string;
}
export interface Campaign {
  id: string; name?: string; status: string; stopReason?: string; startedAt: string; finishedAt?: string; budgetMinutes: number;
  selection: { categories: string[] | null; ids: string[] | null };
  fullSuite: boolean; taskIds: string[]; models: CampaignModel[]; fingerprint: Fingerprint;
}
export interface LoadedCampaign extends Campaign { trials: TrialRecord[]; probes: ProbeRecord[] }

export interface LiveModel { phase: string; done: number; total: number; current: string | null; plan?: string[]; currentSince?: number }
export interface LiveCampaign { id: string; pid: number; status: string; startedAt: string; enginePid?: number; models: Record<string, LiveModel> }

export const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
