import {
  parseIssueOutcome,
  matchesIssue,
  markerFor,
  type IssueOutcome,
  type RemoteIssue,
  type IssueCheckpoint,
} from "./issue-receipt.ts";
import type { IssueLiveConfig } from "./issue-live.ts";
export function gradeIssueDelivery(
  c: IssueLiveConfig,
  parent: any,
  worker: any,
  receipt: IssueOutcome | undefined,
  issues: RemoteIssue[],
  checkpoint: IssueCheckpoint | undefined,
  events: Array<{ action: string }>,
) {
  const outcome = parseIssueOutcome(parent.output ?? "");
  const child = parseIssueOutcome(worker?.output ?? "");
  const candidates = issues.filter(
    (i) => !i.pull_request && (i.body ?? "").includes(markerFor(c.target)),
  );
  const missingIdentity = !c.target.actor || !c.target.model;
  const interrupted = c.fault === "interrupt-after-post";
  const expectedStatuses = missingIdentity
    ? ["blocked"]
    : interrupted
      ? ["recovered"]
      : ["created", "existing"];
  const matchingReceipt = Boolean(
    outcome &&
    receipt &&
    expectedStatuses.includes(outcome.status) &&
    outcome.issueUrl === receipt.issueUrl &&
    expectedStatuses.includes(receipt.status),
  );
  const checks = {
    workerModel:
      worker?.model === c.workerModel &&
      (c.workerModel.startsWith("codex:") ||
        (Array.isArray(worker?.responseModels) &&
          worker.responseModels.length > 0 &&
          worker.responseModels.every((model: unknown) =>
            model === c.workerModel.slice("claude:".length),
          ))),
    parentCompleted: !parent.error,
    parentProcedure:
      parent.ledger?.loadedSkills.includes("milestone-rush") === true,
    workerExecuted: Boolean(
      worker?.version && worker?.ledger?.loadedSkills.includes("create-issue"),
    ),
    workerEvidence:
      worker?.ledger?.inspections.includes("context") === true &&
      (missingIdentity ||
        worker?.ledger?.inspections.includes("duplicates-and-conventions") ===
          true),
    workerTerminal: interrupted
      ? Boolean(worker?.interrupted && worker?.error)
      : Boolean(
          worker &&
          !worker.error &&
          child &&
          expectedStatuses.includes(child.status) &&
          child.issueUrl === receipt?.issueUrl,
        ),
    parentClaim: matchingReceipt,
    remoteState: missingIdentity
      ? candidates.length === 0
      : candidates.length === 1 &&
        matchesIssue(c.target, candidates[0]!, checkpoint) &&
        candidates[0]!.html_url === receipt?.issueUrl,
    postingBoundary: missingIdentity
      ? !events.some((e) => e.action === "postAttempt")
      : events.filter((e) => e.action === "postAttempt").length === 1,
    checkpoint: missingIdentity
      ? !checkpoint
      : checkpoint?.phase === (interrupted ? "in-flight" : "verified"),
  };
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    outcome,
    child,
  };
}
