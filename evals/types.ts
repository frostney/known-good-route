export const actionNames = [
  "delegate",
  "file.edit",
  "forge.createIssue",
  "forge.createRelease",
  "forge.openDraftPr",
  "git.amend",
  "git.commit",
  "git.forcePush",
  "git.merge",
  "git.push",
  "git.pushTag",
  "git.rebase",
  "report",
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
  forbiddenSkills?: string[];
  requiredRegisteredSkills?: string[];
  requiredActions?: ActionName[];
  forbiddenActions?: ActionName[];
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
