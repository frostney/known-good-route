export const actionNames = [
  "delegate",
  "file.edit",
  "forge.closeMilestone",
  "forge.commentIssue",
  "forge.commentPr",
  "forge.createIssue",
  "forge.createRelease",
  "forge.markPrReady",
  "forge.mergePr",
  "forge.openDraftPr",
  "forge.replyInline",
  "forge.resolveThread",
  "forge.updatePrMetadata",
  "git.amend",
  "git.commit",
  "git.createBranch",
  "git.fetch",
  "git.forcePush",
  "git.merge",
  "git.push",
  "git.pushTag",
  "git.rebase",
  "git.stackMerge",
  "git.stackSubmit",
  "git.stackSync",
  "monitor.wait",
  "report",
  "codeReview.run",
  "telemetry.append",
  "user.ask",
  "validation.run",
] as const;

export type ActionName = (typeof actionNames)[number];

export interface ActionRecord {
  action: ActionName;
  details: string;
}

export interface EvalFixture {
  evidence: Record<string, string>;
  registeredSkills?: Record<string, string>;
  actionResponses?: Partial<Record<ActionName, string>>;
}

export interface EvalExpectations {
  requiredSkills?: string[];
  requiredAnySkills?: string[];
  forbiddenSkills?: string[];
  requiredRegisteredSkills?: string[];
  requiredInspections?: string[];
  requiredReferences?: string[];
  requiredInspectionsBeforeActions?: Array<{
    inspection: string;
    action: ActionName;
  }>;
  requiredSkillsBeforeActions?: Array<{
    skill: string;
    action: ActionName;
  }>;
  requiredActionsBeforeActions?: Array<{
    before: ActionName;
    after: ActionName;
  }>;
  requiredActionSequence?: ActionName[];
  requiredActions?: ActionName[];
  requiredAnyActions?: ActionName[];
  forbiddenActions?: ActionName[];
  minActionCounts?: Partial<Record<ActionName, number>>;
  maxActionCounts?: Partial<Record<ActionName, number>>;
  outputPatterns?: string[];
  forbiddenOutputPatterns?: string[];
}

export interface EvalCase {
  id: string;
  description: string;
  prompt: string;
  fixture: EvalFixture;
  expected: EvalExpectations;
}

export interface RunLedger {
  actions: ActionRecord[];
  loadedSkills: string[];
  loadedReferences: string[];
  registeredSkillCalls: string[];
  inspections: string[];
  events: Array<{
    kind: "skill" | "inspection" | "reference" | "action";
    name: string;
  }>;
}

export interface GradeCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface GradeResult {
  passed: boolean;
  checks: GradeCheck[];
}

export interface EvalRunRecord {
  model: string;
  caseId: string;
  repetition: number;
  output: string;
  ledger: RunLedger;
  grade: GradeResult;
  usage?: {
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    totalTokens: number | undefined;
  };
  error?: string;
}
