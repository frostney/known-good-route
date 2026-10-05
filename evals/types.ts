export const actionNames = [
  "delegate",
  "file.edit",
  "skills.migrate",
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
  "git.stackInit",
  "git.stackMerge",
  "git.stackSubmit",
  "git.stackSync",
  "monitor.wait",
  "report",
  "behaviorTest.run",
  "codeReview.run",
  "telemetry.append",
  "user.ask",
  "validation.run",
  "validation.focused",
  "validation.reuse",
] as const;

export type ActionName = (typeof actionNames)[number];

export interface ActionRecord {
  action: ActionName;
  details: string;
  source?: "tool" | "final-response";
  data?: Record<string, unknown>;
}

export interface EvalFixture {
  evidence: Record<string, string>;
  registeredSkills?: Record<string, string>;
  actionResponses?: Partial<Record<ActionName, string | string[]>>;
  transitions?: Array<{
    after: ActionName;
    occurrence?: number;
    // For file.edit, match this exact data.path; only matching edits count.
    editPath?: string;
    evidence: Record<string, string>;
    // Scalar overrides affect subsequent calls, without resetting array counters.
    actionResponses?: Partial<Record<ActionName, string>>;
  }>;
}

export interface EvalExpectations {
  requiredCurrentGates?: {
    before: ActionName[];
    gates: Array<{ action: ActionName; result: string }>;
    ignoreEditPaths?: string[];
  };
  requiredSkillCitations?: Array<import("./skill-citation.ts").SkillCitationRequirement>;
  decisionPacket?: boolean;
  allowedDelegateWorkflows?: string[];
  jsonArtifact?: { path: string; kind: string; schemaVersion: number };
  discoverySkills?: string[];
  allowedEditPaths?: string[];
  reportPatterns?: string[];
  requiredActionDetails?: Array<{
    action: ActionName;
    patterns: string[];
    // "*" includes the action's complete data.
    dataFields?: string[];
    every?: boolean;
    // Only actions recorded before the first action whose text and data match
    // this selector count; with no such action, every action counts.
    before?: { action: ActionName; patterns?: string[] };
  }>;

  requiredWorker?: boolean;
  // A reviewer must write its verdict through writeVerdict; the parent's final
  // response must cite that verdict file, so a review claim is bound to a run
  // that actually happened.
  requiredVerdictFile?: boolean;
  citedReviewVerdict?: boolean;
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
  execution?: "cache-cli" | "authorization-cli";
  // Project AGENTS.md content loaded into the agent's instructions, as a
  // consuming repository would load it.
  agentsMd?: string;
  // Yes/no criteria fixed before any run, for a judge from the other model
  // family. The harness does not grade them yet.
  rubric?: string[];
  models?: string[];
  worker?: { model: string; caseId: string; mode?: "claude-agent" };
  id: string;
  description: string;
  prompt: string;
  fixture: EvalFixture;
  expected: EvalExpectations;
}

export interface RunLedger {
  toolReceiptVersion?: 1;
  toolReceipts?: import("./tool-receipts.ts").ToolReceipt[];
  execution?: {
    revision: string;
    checks: Array<{
      name: string;
      revision: string;
      passed: boolean;
      observations: Array<{
        input: unknown;
        expected: unknown;
        actual: unknown;
        exitCode: number;
      }>;
    }>;
  };
  workers?: Array<{
    mode?: "process" | "claude-agent";
    caseId?: string;
    instructions?: string;
    model: string;
    observedModels: string[];
    responseModels?: string[];
    effort?: string;
    version: string;
    context: string;
    transcript: string;
    verdictFile?: string;
    ledger: RunLedger;
    grade: GradeResult;
    output: string;
    error?: string;
  }>;

  verdict?: { path: string; verdict: "agree" | "disagree"; evidence: string };
  actions: ActionRecord[];
  loadedSkills: string[];
  loadedReferences: string[];
  registeredSkillCalls: string[];
  registeredSkillContexts?: Array<{ name: string; context: string }>;
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
  category?: "discovery";
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
    cachedInputTokens?: number | undefined;
    cacheWriteTokens?: number | undefined;
  };
  durationMs?: number;
  effort?: string;
  runtime?: {
    cli: string;
    version: string;
    requestedModel: string;
    observedModels: string[];
    responseModels?: string[];
    transcript: string;
  };
  error?: string;
}
