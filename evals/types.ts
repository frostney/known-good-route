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
  "git.removeWorktree",
  "git.stackInit",
  "git.stackMerge",
  "git.stackSubmit",
  "git.stackSync",
  "ci.dispatchRun",
  "ci.rerunRun",
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

export const orchestrationEndpoints = ["ready-to-merge", "merged", "deployed"] as const;
export const orchestrationEntryPoints = ["deliver", "stop"] as const;

// The repository configuration a case runs in. Its expected terminal state and
// rubric follow from it, and the runner writes it into the eval workspace.
export interface EvalEnvironment {
  // ORCHESTRATION.md frontmatter and body; null when the repository has none.
  orchestration: {
    endpoint: (typeof orchestrationEndpoints)[number];
    entryPoints: (typeof orchestrationEntryPoints)[number];
    body?: string;
  } | null;
  // Other repository files that change the expected outcome, by path.
  files?: Record<string, string>;
  // The person's standing global agent instructions, which apply across
  // repositories and sit outside the repository (for example a default
  // delivery endpoint). Absent when the person states none.
  standingInstructions?: string;
}

export interface EvalFixture {
  environment?: EvalEnvironment;
  evidence: Record<string, string>;
  registeredSkills?: Record<string, string>;
  actionResponses?: Partial<Record<ActionName, string | string[]>>;
  transitions?: Array<{
    after: ActionName;
    occurrence?: number;
    // Count `after` only from the first time this action was recorded, so
    // "the second wait after the merge" is the same call whatever came before
    // the merge. Without it, occurrences count from the start of the run.
    since?: ActionName;
    // For file.edit, match this exact data.path; only matching edits count.
    editPath?: string;
    // Fire only when this call's scripted result contains this text, so a
    // refused attempt does not apply what only a successful one changes.
    // Without an occurrence, every matching call fires it.
    whenResult?: string;
    // Fire only when this call carries every value, matched as for
    // requiredActionValues, such as a wait on one exact head. A list of
    // conditions needs all of them, each matched its own way. Without an
    // occurrence, every matching call fires it.
    whenCarries?: ValueMatch | ValueMatch[];
    // Fire only when, for each entry, an earlier call of that action carried
    // every condition and, with withResult, got a result containing that
    // text, such as a push before a PR can open on its branch.
    whenRecorded?: Array<{ action: ActionName; carries?: ValueMatch[]; withResult?: string }>;
    // This call's own result in place of its scripted one, so only a call
    // that carries the right values succeeds. The first matching transition
    // with a result gives it, and its whenResult reads the scripted result.
    result?: string;
    evidence: Record<string, string>;
    // Overrides affect subsequent calls. A sequence starts at its first
    // response on the next call; a scalar replaces whatever was there.
    actionResponses?: Partial<Record<ActionName, string | string[]>>;
  }>;
}

export interface EvalExpectations {
  requiredCurrentGates?: {
    before: ActionName[];
    // With values, a call renews its gate only when it carries every value and
    // none of forbiddenValues, matched as for requiredActionValues. The latest
    // call to a gate's action decides, so a later call that lacks them leaves
    // the gate missing even after an earlier one qualified.
    gates: Array<{ action: ActionName; result: string; values?: ExactValue[]; forbiddenValues?: ExactValue[] }>;
    ignoreEditPaths?: string[];
  };
  requiredSkillCitations?: Array<import("./skill-citation.ts").SkillCitationRequirement>;
  decisionPacket?: boolean;
  allowedDelegateWorkflows?: string[];
  jsonArtifact?: { path: string; kind: string; schemaVersion: number };
  discoverySkills?: string[];
  allowedEditPaths?: string[];
  // Answer correctness, judged by a model of the other family (judge.ts).
  // Exact values never go in the rubric; they are the code checks below.
  rubric?: RubricItem[];
  // Message items this case adds to the shared set in judge.ts.
  messageRubric?: RubricItem[];
  // Each value must appear as a whole token in the answer's communication: the
  // final response, report and question actions, and posted replies and
  // comments. An inner array lists accepted spellings of one value.
  requiredAnswerValues?: ExactValue[];
  // Values that must not appear as a whole token in that communication.
  forbiddenAnswerValues?: string[];
  // Each value must be carried by a recorded action of that kind, matched as
  // ValueMatch describes. With every, all such actions must carry it;
  // otherwise one is enough.
  requiredActionValues?: Array<ValueMatch & {
    action: ActionName;
    every?: boolean;
    // The same action must also carry each of these, matched its own way,
    // such as a request's method, path and JSON body together.
    also?: ValueMatch[];
    // Only actions recorded before this occurrence (default 1) of the named
    // action count; the check fails when that occurrence is absent.
    before?: { action: ActionName; occurrence?: number };
    // Only actions recorded after this occurrence (default 1) of the named
    // action count; the check fails when that occurrence is absent.
    after?: { action: ActionName; occurrence?: number };
  }>;
  // No recorded action of that kind may carry any of the values, matched as
  // for requiredActionValues. With before, only actions recorded before that
  // occurrence (default 1) of the named action count, and every action counts
  // when that occurrence is absent. Use it where an action is wrong only for
  // some targets, such as a wait on the default branch's run.
  forbiddenActionValues?: Array<ValueMatch & {
    action: ActionName;
    before?: { action: ActionName; occurrence?: number };
  }>;

  requiredWorker?: boolean;
  // The configured worker stays available but must not start, so skipping it
  // is the run's own decision, such as a review the evidence does not call for.
  forbiddenWorker?: boolean;
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
    // The inspection must also follow the first such action, such as an
    // inspection of what a creation published.
    after?: ActionName;
  }>;
  requiredSkillsBeforeActions?: Array<{
    skill: string;
    action: ActionName;
  }>;
  // The reference must be read before the first `action`.
  requiredReferencesBeforeActions?: Array<{
    reference: string;
    action: ActionName;
  }>;
  requiredActionsBeforeActions?: Array<{
    before: ActionName;
    after: ActionName;
  }>;
  // No `action` may be recorded before the first `before` action; when that
  // action is absent, every recorded `action` counts. Use it where an action
  // is wrong only until another has happened, such as a dispatch before a
  // merge that is the first thing to leave anything for the dispatch to cover.
  forbiddenActionsBeforeActions?: Array<{
    action: ActionName;
    before: ActionName;
  }>;
  // No `action` may be recorded after the first `after` action; when that
  // action is absent, nothing is forbidden. Use it where an action is wrong
  // once another has happened, such as an edit after the commit that is pushed.
  forbiddenActionsAfterActions?: Array<{
    action: ActionName;
    after: ActionName;
  }>;
  // The native worker must have started before the first of each action.
  requiredWorkerBeforeActions?: ActionName[];
  // Each action must be recorded before the native worker started, so what the
  // worker can see cannot stand in for the action. With values, only a record
  // carrying all of them, matched as for requiredActionValues, counts.
  requiredActionsBeforeWorker?: Array<ActionName | { action: ActionName; values: ExactValue[] }>;
  // Each source must be inspected before the native worker started, so the
  // explanation the worker reviews already rests on it.
  requiredInspectionsBeforeWorker?: string[];
  requiredActionSequence?: ActionName[];
  requiredActions?: ActionName[];
  requiredAnyActions?: ActionName[];
  forbiddenActions?: ActionName[];
  minActionCounts?: Partial<Record<ActionName, number>>;
  maxActionCounts?: Partial<Record<ActionName, number>>;
}

export type ExactValue = string | string[];

// Values a recorded action carries: equal to one of the named data fields (or
// an element of an array field), or, without fields, a whole token in its
// details or data. A named field is also read from a recorded `command`, as
// its `--field value` or `--field=value` flag. The options below change how a
// value matches inside the named fields; each needs fields, and a rule takes
// at most one of them.
export interface ValueMatch {
  values: ExactValue[];
  fields?: string[];
  // A whole token inside the field, such as a path inside a body, instead of
  // the whole field.
  within?: boolean;
  // The field, or an element of it, may continue the value with this
  // separator and more text, such as an attachment's `#alt text`.
  suffix?: string;
  // The value is the destination of a Markdown image that stands alone in its
  // paragraph, the placement where GitHub plays an uploaded video.
  alone?: boolean;
  // The field holds JSON, as an object or a string that parses, equal to the
  // value's JSON whatever its spacing or key order.
  json?: boolean;
}

export interface RubricItem {
  id: string;
  // A yes/no question about the outcome or result; a correct answer earns yes.
  question: string;
}

export interface EvalCase {
  execution?: "cache-cli" | "authorization-cli";
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
    // Parent ledger event count when the worker started, so its order against
    // the parent's actions can be checked.
    startedAtEvent?: number;
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
  category?: "discovery" | "rubric" | "message";
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
  judgement?: import("./judge.ts").Judgement;
  // Exactly what the run saw: the written configuration files, the injected
  // AGENTS.md and the case's repository evidence.
  environment?: {
    files: Record<string, string>;
    agentsMd: string;
    repoContext: Record<string, string>;
    standingInstructions?: string;
  };
  error?: string;
}
