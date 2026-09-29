import type { ActionName, EvalCase } from "./types.ts";

// A change that contains another open PR's commits. The dependency is observable
// only from Git history and the open-PR listing, as it was for #96 on #94. The
// listing uses the fields of the real command that create-pr prescribes; it has
// no commit data, so detection has to compare history.
const main = "a".repeat(40);
const schema = "0".repeat(40);
const budget = "1".repeat(40);
const report = "2".repeat(40);
const parser = "3".repeat(40);
const fork = "4".repeat(40);
const backport = "5".repeat(40);
const release = "6".repeat(40);
const releaseFix = "7".repeat(40);
const pr = (number: number, headRefName: string, headRefOid: string, baseRefName = "main", isCrossRepository = false) =>
  ({ baseRefName, headRefName, headRefOid, isCrossRepository, number });
const listing = (...rows: ReturnType<typeof pr>[]) => JSON.stringify(rows);
const common = {
  repositoryStatus: `Repository example/project on github.com. The clean current branch feat/budget-report is at ${report}, two commits ahead of freshly fetched origin/main at ${main}. No unrelated local work.`,
  branchHistory: `$ git rev-list origin/main..HEAD\n${report}\n${budget}\n$ git log --oneline origin/main..HEAD\n2222222 feat(report): show remaining allowance\n1111111 feat(budget): add allowance budget`,
  projectDefinitions: "Issue #121 asks for the remaining allowance in the budget report. This branch's change completes #121.",
  completionEvidence: `Independent code review and real-interface behavior testing passed on exact head ${report} for issue #121's claim.`,
  projectGate: `The declared gate passed on the unchanged head ${report}.`,
  pullRequest: "No pull request exists for feat/budget-report.",
};
const publication: ActionName[] = [
  "forge.mergePr", "forge.openDraftPr", "git.amend", "git.forcePush", "git.push", "git.rebase", "git.stackMerge",
];
const stopped: ActionName[] = [
  ...publication, "forge.markPrReady", "forge.updatePrMetadata", "git.stackInit", "git.stackSubmit",
];
export const historyInspections = ["openPullRequests", "pullRequestHeads", "branchHistory"];

export const stackDependencyCases: EvalCase[] = [
  {
    id: "create-pr-dependent-change-native-stack",
    description: "A change whose history contains another open PR's commits is published as a native stack adopting that PR, not as a PR whose base is set by hand to its branch.",
    prompt: "/create-pr for issue #121.",
    fixture: {
      evidence: {
        ...common,
        openPullRequests: listing(pr(120, "feat/allowance-budget", budget), pr(118, "fix/parser-escape", parser)),
        pullRequestHeads: `$ git fetch origin pull/120/head pull/118/head\n$ git rev-list origin/main..${budget}\n${budget}\n$ git rev-list origin/main..${parser}\n${parser}`,
        stackTopology: `gh stack view --json reports no locally tracked stack, and GitHub reports no native stack for #118 or #120. Neither PR is approved or has auto-merge enabled. The official gh-stack extension is installed and authenticated. Local feat/allowance-budget and fix/parser-escape match their remote heads ${budget} and ${parser}.`,
        continuousIntegration: `After publication, every check on exact head ${report} reaches a successful terminal result.`,
      },
      actionResponses: {
        "git.stackInit": "gh stack init adopted feat/allowance-budget and feat/budget-report as a two-layer local stack on trunk main. No branch was rewritten.",
        "git.stackSubmit": `GitHub reports native stack 31 in bottom-to-top order: existing PR #120 feat/allowance-budget at ${budget} with base main, unchanged, and new draft PR #122 feat/budget-report at ${report}. No other PR changed.`,
        "monitor.wait": `Every check on PR #122's exact head ${report} reached a successful terminal result.`,
        "forge.markPrReady": `PR #122 is ready for review at ${report}.`,
      },
    },
    expected: {
      requiredSkills: ["create-pr", "git-workflow"],
      requiredReferences: ["git-workflow/references/github-stacks.md"],
      requiredInspectionsBeforeActions: historyInspections.map(inspection => ({ inspection, action: "git.stackInit" as const })),
      requiredActions: ["git.stackInit", "git.stackSubmit", "forge.markPrReady"],
      // Every init adopts exactly the PR whose commits the branch contains, bottom to top.
      requiredActionDetails: [{ action: "git.stackInit", patterns: ['init\\s+feat/allowance-budget\\s+feat/budget-report\\b|\\["feat/allowance-budget","feat/budget-report"\\]'], dataFields: ["*"], every: true }],
      requiredActionsBeforeActions: [{ before: "git.stackInit", after: "git.stackSubmit" }],
      forbiddenActions: publication,
      reportPatterns: ["stack", "\\b120\\b", "\\b122\\b"],
    },
  },
  {
    id: "create-pr-dependency-on-hand-based-pr-stops",
    description: "When the PR a change builds on is based by hand on another PR's branch instead of the default, publication stops and reports the topology rather than changing either PR.",
    prompt: "/create-pr for issue #121.",
    fixture: {
      evidence: {
        ...common,
        branchHistory: `$ git rev-list origin/main..HEAD\n${report}\n${budget}\n${schema}\n$ git log --oneline origin/main..HEAD\n2222222 feat(report): show remaining allowance\n1111111 feat(budget): add allowance budget\n0000000 feat(budget): define the budget schema`,
        repositoryStatus: `Repository example/project on github.com. The clean current branch feat/budget-report is at ${report}, three commits ahead of freshly fetched origin/main at ${main}. No unrelated local work.`,
        openPullRequests: listing(pr(119, "feat/budget-schema", schema), pr(120, "feat/allowance-budget", budget, "feat/budget-schema")),
        pullRequestHeads: `$ git fetch origin pull/119/head pull/120/head\n$ git rev-list origin/main..${schema}\n${schema}\n$ git rev-list origin/main..${budget}\n${budget}\n${schema}`,
        stackTopology: `gh stack view --json reports no locally tracked stack, and GitHub reports no native stack for #119 or #120. Neither PR is approved or has auto-merge enabled. The official gh-stack extension is installed and authenticated. Local feat/budget-schema and feat/allowance-budget match their remote heads.`,
      },
    },
    expected: {
      requiredSkills: ["create-pr", "git-workflow"],
      requiredReferences: ["git-workflow/references/github-stacks.md"],
      requiredInspections: historyInspections,
      requiredAnyActions: ["user.ask", "report"],
      forbiddenActions: stopped,
      reportPatterns: ["\\b120\\b", "\\bbase", "budget-schema|#?119\\b"],
    },
  },
  {
    id: "create-pr-dependency-on-fork-pr-stops",
    description: "A change that contains a fork PR's commits cannot stack on it, so publication stops and reports instead of opening an ordinary PR that carries those commits.",
    prompt: "/create-pr for issue #121.",
    fixture: {
      evidence: {
        ...common,
        openPullRequests: listing(pr(130, "main", budget, "main", true)),
        pullRequestHeads: `$ git fetch origin pull/130/head\n$ git rev-list origin/main..${budget}\n${budget}`,
        stackTopology: "gh stack view --json reports no locally tracked stack. GitHub reports no native stack. The official gh-stack extension is installed and authenticated.",
      },
    },
    expected: {
      requiredSkills: ["create-pr"],
      requiredInspections: historyInspections,
      requiredAnyActions: ["user.ask", "report"],
      forbiddenActions: stopped,
      reportPatterns: ["\\b130\\b", "fork|cross.repositor"],
    },
  },
  {
    id: "create-pr-unrelated-open-prs-publish-normally",
    description: "Open PRs that share no commits with the change, including a fork PR from a branch named main, leave an ordinary publication against the default branch.",
    prompt: "/create-pr for issue #121.",
    fixture: {
      evidence: {
        ...common,
        repositoryStatus: `Repository example/project on github.com. The clean current branch feat/budget-report is at ${report}, one commit ahead of freshly fetched origin/main at ${main}. No unrelated local work.`,
        branchHistory: `$ git rev-list origin/main..HEAD\n${report}\n$ git log --oneline origin/main..HEAD\n2222222 feat(report): show remaining allowance`,
        openPullRequests: listing(pr(118, "fix/parser-escape", parser), pr(130, "main", fork, "main", true)),
        pullRequestHeads: `$ git fetch origin pull/118/head pull/130/head\n$ git rev-list origin/main..${parser}\n${parser}\n$ git rev-list origin/main..${fork}\n${fork}`,
        stackTopology: "gh stack view --json reports no locally tracked stack. GitHub reports no native stack.",
        continuousIntegration: `After publication, every check on exact head ${report} reaches a successful terminal result.`,
      },
      actionResponses: {
        "git.push": `Normal push published feat/budget-report at ${report}.`,
        "forge.openDraftPr": `Draft PR #122 opened for feat/budget-report at ${report} against main.`,
        "monitor.wait": `Every check on PR #122's exact head ${report} reached a successful terminal result.`,
        "forge.markPrReady": `PR #122 is ready for review at ${report}.`,
      },
    },
    expected: {
      requiredSkills: ["create-pr"],
      requiredInspections: historyInspections,
      requiredActions: ["git.push", "forge.openDraftPr", "forge.markPrReady"],
      forbiddenActions: ["forge.mergePr", "git.amend", "git.forcePush", "git.rebase", "git.stackInit", "git.stackSubmit", "git.stackMerge", "user.ask"],
      reportPatterns: ["\\b122\\b"],
    },
  },
  {
    id: "create-pr-named-release-base-publishes-normally",
    description: "A backport onto a user-named release branch publishes as an ordinary PR against that branch, even while an open PR has the release branch as its head.",
    prompt: "/create-pr for issue #140. This is a backport onto release/1.x.",
    fixture: {
      evidence: {
        repositoryStatus: `Repository example/project on github.com. The clean current branch backport/retry-budget is at ${backport}, created from freshly fetched origin/release/1.x at ${release}. Freshly fetched origin/main is at ${main}. No unrelated local work.`,
        branchHistory: `$ git rev-list origin/release/1.x..HEAD\n${backport}\n$ git rev-list origin/main..HEAD\n${backport}\n${release}\n${releaseFix}`,
        openPullRequests: listing(pr(150, "release/1.x", release)),
        pullRequestHeads: `$ git fetch origin pull/150/head\n$ git rev-list origin/release/1.x..${release}\n$ git rev-list origin/main..${release}\n${release}\n${releaseFix}`,
        stackTopology: "gh stack view --json reports no locally tracked stack. GitHub reports no native stack.",
        projectDefinitions: "Issue #140 asks for the retry budget fix on the 1.x release line. This branch's change completes #140.",
        completionEvidence: `Independent code review and real-interface behavior testing passed on exact head ${backport} for issue #140's claim.`,
        projectGate: `The declared gate passed on the unchanged head ${backport}.`,
        pullRequest: "No pull request exists for backport/retry-budget.",
        continuousIntegration: `After publication, every check on exact head ${backport} reaches a successful terminal result.`,
      },
      actionResponses: {
        "git.push": `Normal push published backport/retry-budget at ${backport}.`,
        "forge.openDraftPr": `Draft PR #151 opened for backport/retry-budget at ${backport} against release/1.x.`,
        "monitor.wait": `Every check on PR #151's exact head ${backport} reached a successful terminal result.`,
        "forge.markPrReady": `PR #151 is ready for review at ${backport}.`,
      },
    },
    expected: {
      requiredSkills: ["create-pr"],
      requiredInspections: historyInspections,
      requiredActions: ["git.push", "forge.openDraftPr", "forge.markPrReady"],
      requiredActionDetails: [{ action: "forge.openDraftPr", patterns: ["release/1\\.x"], dataFields: ["*"], every: true }],
      forbiddenActions: ["forge.mergePr", "git.amend", "git.forcePush", "git.rebase", "git.stackInit", "git.stackSubmit", "git.stackMerge", "user.ask"],
      reportPatterns: ["\\b151\\b", "release/1\\.x"],
    },
  },
];
