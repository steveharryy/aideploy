/**
 * Planning phase contract.
 *
 * The Planning Agent turns a Jira ticket into this structure. The orchestrator code (not the
 * model) decides what to do with it: post the plan for approval, ask questions, or send the
 * ticket back to the reporter. The coding phase receives one work item at a time.
 */

/** ready: plan can be approved. blocking: a human must answer questions first. too_vague: send back to the reporter. */
export type ReadinessVerdict = 'ready' | 'blocking' | 'too_vague';

/** How an acceptance criterion will be proven. */
export type VerifyMethod = 'unit_test' | 'qa_api_check' | 'human';

export type RiskLevel = 'low' | 'medium' | 'high';

export type Confidence = 'high' | 'medium' | 'low';

/** A blocking question with ready-made options so people can answer in seconds. */
export interface PlanQuestion {
  id: string; // Q1, Q2 ...
  text: string;
  options: string[];
  /** The option the agent would pick if forced to. */
  defaultOption?: string;
  /** Where the question comes from: a checklist item (e.g. expected_behaviour) or an edge case (EC2). */
  from?: string;
  /** Other checklist items / edge cases asking the same thing, merged into this question. */
  covers?: string[];
}

/** The 7-item readiness checklist (spec: "Finding missing information"). */
export const CHECKLIST_ITEMS = ['expected_behaviour', 'current_behaviour', 'product', 'example', 'edge_cases', 'scope', 'verification'] as const;
export type ChecklistItem = (typeof CHECKLIST_ITEMS)[number];
export const CHECKLIST_LABELS: Record<ChecklistItem, string> = {
  expected_behaviour: 'Expected behaviour',
  current_behaviour: 'Current behaviour',
  product: 'Product and repo',
  example: 'Example',
  edge_cases: 'Edge cases',
  scope: 'Scope',
  verification: 'Verification'
};
/** Without these the ticket cannot be planned at all: either one missing → too_vague. */
export const ESSENTIAL_ITEMS: ChecklistItem[] = ['expected_behaviour', 'product'];

export type GapStatus = 'found' | 'missing' | 'ambiguous';
/** "If I guess wrong, does it change what users see, money or data?" no → minor, yes → blocking. */
export type GapSeverity = 'minor' | 'blocking';

/** One checklist item, as judged by the agent. */
export interface GapEntry {
  item: ChecklistItem;
  status: GapStatus;
  /** Where it was found, or why it is missing/ambiguous. */
  source: string;
  severity?: GapSeverity;
  /** Blocking gaps: the question to ask. */
  question?: string;
  options?: string[];
  defaultOption?: string;
  /** Minor gaps: the safe default chosen. */
  assumption?: string;
}

/** handled → regression test; not_affected → noted; safe_default → assumption; unclear → blocking question. */
export type EdgeCaseStatus = 'handled' | 'not_affected' | 'safe_default' | 'unclear';

export interface EdgeCase {
  id: string; // EC1, EC2 ...
  case: string;
  /** code | tests | past_bugs | domain | generic */
  source: string;
  status: EdgeCaseStatus;
  /** handled: name of the test in test_plan that covers it. */
  test?: string;
  /** safe_default: the default chosen. not_affected: why. */
  note?: string;
  question?: string;
  options?: string[];
  defaultOption?: string;
}

/** One unit of coding work in one repository. */
export interface WorkItem {
  id: string; // W1, W2 ...
  repo: string; // catalog repo id
  task: string;
  /** Why this repo (cite code where possible, e.g. "tie logic lives in src/contest/payout.ts"). */
  reason: string;
  confidence: Confidence;
  /** Work item ids that must finish first. */
  dependsOn: string[];
  filesLikelyTouched: string[];
  /** Ordered implementation steps. */
  approach: string[];
  /**
   * The repo's EXISTING tests already fail on the base branch: the minimal repair, done first.
   * Only tests and test-runner config (never source). Shown to the approver; the coding agent
   * may only touch these files for it.
   */
  baselineFix?: { files: string[]; reason: string };
}

export interface PlanAcceptanceCriterion {
  id: string; // AC1, AC2 ...
  text: string;
  verify: VerifyMethod;
  workItem: string;
  /** "ticket" = written in Jira; "derived" = proposed by the agent (the approver confirms it). */
  source: 'ticket' | 'derived';
}

export interface PlannedTest {
  ac: string;
  workItem: string;
  /** Test name, e.g. "test_AC1_tied_ranks_split_evenly". */
  name: string;
  cases: string[];
}

export interface TicketPlan {
  ticket: string;
  summary: string;
  readiness: ReadinessVerdict;
  /** Minor gaps filled with a safe default. Shown to the approver. */
  assumptions: string[];
  /** Answers already given by people (comments, earlier question rounds), with who answered. */
  clarifications: string[];
  /** Blocking gaps (readiness = blocking). */
  questions: PlanQuestion[];
  /** What the reporter must add (readiness = too_vague). */
  missingForReporter: string[];
  /** Interfaces two repos/agents must agree on (API shapes, field names, events, DB changes). */
  contract: string[];
  workItems: WorkItem[];
  acceptanceCriteria: PlanAcceptanceCriterion[];
  testPlan: PlannedTest[];
  risk: RiskLevel;
  riskReason: string;
  outOfScope: string[];
  /** Set by code, never by the model: things the approver must check (e.g. repo differs from the component map). */
  warnings: string[];
  /** One entry per checklist item. When present, code (not the model) decides the readiness verdict. */
  gapAnalysis: GapEntry[];
  edgeCases: EdgeCase[];
}
