import { expect, test } from "bun:test";
import { deliveryChecks, implementationReport } from "./retro-live.ts";
import { validateTarget, type LiveConfig } from "./github-live.ts";
import { validateIssueTarget, titleFor, type IssueTarget } from "./issue-receipt.ts";
import { emptyIssueLedger, requireIssueProcedure } from "./issue-live.ts";
const c = { repository: "frostney/kgr-eval-20260905-native-delivery", repositoryId: 1358601587, branch: "codex/eval-retro-test", base: "a".repeat(40), model: "claude:claude-opus-5", issueUrl: "https://github.com/frostney/kgr-eval-20260905-native-delivery/issues/1" } as LiveConfig;
function example() {
  const head = "b".repeat(40), revision = "content-hash", attempt = "review-1";
  const result = { output: "Delivered", model: c.model, exitCode: 0, responseModels: ["claude-opus-5"], ledger: { loadedSkills: ["implement", "create-pr"] } };
  const state = { head, reviews: [{ attempt, revision, model: c.model, verdict: "pass", findings: [] }], checks: [{ revision: "old", passed: false }, { revision, passed: true }], events: [
    { action: "reviewProcess", attempt, revision, model: c.model, exitCode: 0, completed: true, loadedSkills: ["code-review"] },
    { action: "draftPublished", revision, reviewAttempt: attempt, head },
    { action: "ciObserved", code: 0, observed: { state: "satisfied", identity: { head } } },
    { action: "ready", head },
  ] };
  const observed = { head, revision, status: "", files: ["app.mjs"], pr: { head: { sha: head, ref: c.branch }, body: `Closes ${c.issueUrl}`, draft: false, state: "open", merged_at: null }, checkRuns: [{ name: "project-gate", head_sha: head, status: "completed", conclusion: "success" }] };
  return { result, state, observed };
}
test("retrospective delivery rejects stale gates, failed workers, missing review, wrong issue and changed scope", () => {
  const original = example();
  const passes = (e: any) => Object.values(deliveryChecks(c, e.result, e.state, e.observed)).every(Boolean);
  expect(passes(original)).toBeTrue();
  const changes: Array<(e: any) => void> = [
    e => e.result.error = "interrupted", e => e.result.responseModels = ["other"],
    e => e.result.ledger.loadedSkills = ["run-retro"], e => e.state.checks[1].revision = "old",
    e => e.state.reviews[0].findings = [{ withinScope: true, severity: "IMPORTANT" }],
    e => e.state.events[0].completed = false, e => e.observed.status = " M app.mjs",
    e => e.observed.files.push(".github/workflows/ci.yml"), e => e.observed.pr.head.sha = "c".repeat(40),
    e => e.observed.pr.body = "Closes https://github.com/other/project/issues/1",
    e => e.observed.checkRuns[0].head_sha = "old", e => e.observed.checkRuns[0].conclusion = "failure",
    e => e.observed.checkRuns.push({ ...e.observed.checkRuns[0] }),
    e => e.state.events[2].observed.identity.head = "old", e => e.observed.pr.draft = true,
    e => e.observed.pr.merged_at = "yesterday", e => e.state.events.reverse(),
  ];
  for (const change of changes) { const e = structuredClone(original); change(e); expect(passes(e)).toBeFalse(); }
  expect(implementationReport(original.result)).not.toHaveProperty("ledger");
});
test("retrospective prerequisite gate belongs to the coordinator while issue creation stays with its worker", async () => {
  const ledger = emptyIssueLedger(); ledger.loadedSkills.push("run-retro");
  await requireIssueProcedure("parent", ledger, "delegateIssue", async () => {}, "run-retro");
  await expect(requireIssueProcedure("worker", ledger, "createIssue", async () => {}, "run-retro")).rejects.toThrow("create-issue");
  await expect(requireIssueProcedure("parent", ledger, "delegateIssue", async () => {})).rejects.toThrow("milestone-rush");
});
test("custom visibility issue subjects retain exact disposable repository and title boundaries", () => {
  expect(() => validateTarget(c)).not.toThrow();
  expect(() => validateTarget({ ...c, issueUrl: "https://github.com/other/project/issues/1" })).toThrow("Visibility issue");
  const target: IssueTarget = { repository: c.repository, repositoryId: c.repositoryId, key: "retro-test-123", actor: "frostney", model: "claude-opus-5", subject: "Preserve supplied lines" };
  validateIssueTarget(target); expect(titleFor(target)).toBe("[KGR eval retro-test-123] Preserve supplied lines");
  for (const subject of ["", "x\ny", " ", "x".repeat(101)]) expect(() => validateIssueTarget({ ...target, subject })).toThrow();
});
