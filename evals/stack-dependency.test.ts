import { expect, test } from "bun:test";
import { gradeRun } from "./grading.ts";
import { historyInspections as inspections, stackDependencyCases } from "./stack-dependency-cases.ts";
import type { ActionName, RunLedger } from "./types.ts";

const byId = (id: string) => stackDependencyCases.find((c) => c.id === id)!;
const failed = (
  id: string,
  actions: RunLedger["actions"],
  output: string,
  { references = ["git-workflow/references/github-stacks.md"], inspected = inspections } = {},
) =>
  gradeRun(
    byId(id),
    {
      actions,
      loadedSkills: ["create-pr", "git-workflow"],
      loadedReferences: references,
      registeredSkillCalls: [],
      inspections: inspected,
      events: [
        ...inspected.map((name) => ({ kind: "inspection" as const, name })),
        ...actions.map((a) => ({ kind: "action" as const, name: a.action })),
      ],
    },
    output,
  )
    .checks.filter((c) => !c.passed)
    .map((c) => c.name);
const act = (action: ActionName, details: string, data?: Record<string, unknown>) => ({
  action, details, ...(data ? { data } : {}),
});

test("open-PR fixtures have the fields of the real listing command and no commit data", () => {
  for (const c of stackDependencyCases)
    for (const row of JSON.parse(c.fixture.evidence.openPullRequests!))
      expect(Object.keys(row).sort()).toEqual(["baseRefName", "headRefName", "headRefOid", "isCrossRepository", "number"]);
});

test("a change containing an open PR's commits is stacked on that PR only", () => {
  const id = "create-pr-dependent-change-native-stack";
  const output = "Native stack 31: #120 stays at the bottom and #122 is ready on top.";
  const init = act("git.stackInit", "Adopt both branches bottom to top", { command: "gh stack init feat/allowance-budget feat/budget-report" });
  const rest = [act("git.stackSubmit", "Submit the adopted stack"), act("forge.markPrReady", "Mark #122 ready")];
  expect(failed(id, [init, ...rest], output)).toEqual([]);
  expect(failed(id, [init, ...rest], output, { references: [] })).toEqual(["required references"]);
  // Naming the excluded PR in the explanation is fine; adopting it is not.
  expect(failed(id, [{ ...init, details: "Adopt #120 only; #118 fix/parser-escape shares no commits" }, ...rest], output)).toEqual([]);
  expect(failed(id, [act("git.stackInit", "Adopt", { branches: ["feat/allowance-budget", "feat/budget-report"] }), ...rest], output)).toEqual([]);
  expect(failed(id, [init, ...rest], output, { inspected: ["openPullRequests", "branchHistory"] }))
    .toEqual(["pullRequestHeads before git.stackInit"]);
  // The #96 shape: an ordinary PR whose base is set by hand to the lower PR's branch.
  expect(failed(id, [
    act("git.push", "Push feat/budget-report"),
    act("forge.openDraftPr", "gh pr create --draft", { base: "feat/allowance-budget" }),
    act("forge.markPrReady", "Mark #122 ready"),
  ], output)).toEqual(expect.arrayContaining(["required actions", "forbidden actions"]));
});

test("a lower PR based by hand on another PR's branch stops publication", () => {
  const id = "create-pr-dependency-on-hand-based-pr-stops";
  const output = "Stopped: #120 is based on feat/budget-schema, not main, so stacking would retarget it. No PR was opened.";
  expect(failed(id, [], output)).toEqual([]);
  expect(failed(id, [act("git.stackInit", "gh stack init feat/allowance-budget feat/budget-report"), act("git.stackSubmit", "Submit")], output))
    .toEqual(["forbidden actions"]);
});

test("a change built on a fork PR stops instead of opening an ordinary PR", () => {
  const id = "create-pr-dependency-on-fork-pr-stops";
  const output = "Stopped: this branch contains commits of fork PR #130, which cannot be a stack base here.";
  expect(failed(id, [], output)).toEqual([]);
  expect(failed(id, [act("git.push", "Push"), act("forge.openDraftPr", "Open against main")], "Opened PR #131 against main."))
    .toEqual(expect.arrayContaining(["forbidden actions"]));
});

test("open PRs that share no commits leave an ordinary publication", () => {
  const id = "create-pr-unrelated-open-prs-publish-normally";
  const output = "PR #122 is ready for review against main.";
  const ordinary = [act("git.push", "Push feat/budget-report"), act("forge.openDraftPr", "Open against main", { base: "main" }), act("forge.markPrReady", "Mark #122 ready")];
  expect(failed(id, ordinary, output)).toEqual([]);
  // Stopping because a fork PR's head branch is also called main is a false positive.
  expect(failed(id, [], "Stopped: fork PR #130's head branch is main, the intended base."))
    .toEqual(expect.arrayContaining(["required actions"]));
  expect(failed(id, [act("git.stackInit", "gh stack init fix/parser-escape feat/budget-report"), ...ordinary], output))
    .toEqual(["forbidden actions"]);
});

test("a backport onto a named release base publishes against it, not as a stack", () => {
  const id = "create-pr-named-release-base-publishes-normally";
  const output = "PR #151 is ready for review against release/1.x.";
  const push = act("git.push", "Push backport/retry-budget");
  const ready = act("forge.markPrReady", "Mark #151 ready");
  expect(failed(id, [push, act("forge.openDraftPr", "Open the backport", { base: "release/1.x" }), ready], output)).toEqual([]);
  // The release branch is the head of open PR #150, but it is the named base, not a lower PR.
  expect(failed(id, [act("git.stackInit", "gh stack init release/1.x backport/retry-budget"), act("git.stackSubmit", "Submit"), ready], output))
    .toEqual(expect.arrayContaining(["forbidden actions"]));
  expect(failed(id, [], "Stopped: open PR #150's head release/1.x is the intended base."))
    .toEqual(expect.arrayContaining(["required actions"]));
});

test("a backport that merged default-branch commits is not a dependency of an up-to-date default PR", () => {
  const id = "create-pr-named-release-base-publishes-normally";
  const output = "PR #151 is ready for review against release/1.x.";
  const ready = act("forge.markPrReady", "Mark #151 ready");
  // #160 shares the merged default commit only when the default branch is not excluded.
  expect(failed(id, [act("git.stackInit", "gh stack init feat/export-csv backport/retry-budget"), act("git.stackSubmit", "Submit"), ready], output))
    .toEqual(expect.arrayContaining(["forbidden actions"]));
  expect(failed(id, [], "Stopped: the backport shares a commit with #160.")).toEqual(expect.arrayContaining(["required actions"]));
});

test("a backport that contains a default-branch PR's commits stops instead of stacking on the default trunk", () => {
  const id = "create-pr-named-base-dependency-on-default-pr-stops";
  const output = "Stopped: the release/1.x backport contains commits of #120, whose base is main, not release/1.x. Nothing was published.";
  expect(failed(id, [], output)).toEqual([]);
  expect(failed(id, [act("git.stackInit", "gh stack init feat/allowance-budget backport/retry-budget"), act("git.stackSubmit", "Submit")], output))
    .toEqual(["forbidden actions"]);
  expect(failed(id, [act("git.push", "Push"), act("forge.openDraftPr", "Open against release/1.x", { base: "release/1.x" })], "PR #151 is open."))
    .toEqual(expect.arrayContaining(["forbidden actions"]));
});

test("a listing that fills the limit is treated as truncated", () => {
  const id = "create-pr-truncated-open-pr-list-stops";
  expect(JSON.parse(byId(id).fixture.evidence.openPullRequests!)).toHaveLength(1000);
  const output = "Stopped: the open-PR listing returned exactly 1000 rows, the --limit, so it may be truncated. Nothing was published.";
  expect(failed(id, [], output, { inspected: ["openPullRequests"] })).toEqual([]);
  expect(failed(id, [act("git.push", "Push"), act("forge.openDraftPr", "Open against main", { base: "main" })], "PR #122 is open.", { inspected: ["openPullRequests"] }))
    .toEqual(expect.arrayContaining(["forbidden actions"]));
});
