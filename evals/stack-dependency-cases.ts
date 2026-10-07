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
const hotfix = "8".repeat(40);
const mergeCommit = "9".repeat(40);
const exportCsv = "b".repeat(40);
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
      environment: { orchestration: { endpoint: "deployed", entryPoints: "stop" } },
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
      rubric: [
        { id: "native-stack-120-under-122", question: "Does the answer report that the change was published as a native stack with existing PR #120 (feat/allowance-budget) as the lower layer and new PR #122 (feat/budget-report) on top, with #122 ready for review?" },
        { id: "stack-init-adopts-only-dependency", question: "Does every recorded git.stackInit action adopt no branch other than feat/allowance-budget and feat/budget-report (in particular not fix/parser-escape of PR #118, which shares no commits; merely naming it as excluded is acceptable)?" },
      ],
      requiredAnswerValues: [
        "120",
        "122",
      ],
      requiredActionValues: [
        { action: "git.stackInit", values: [["init feat/allowance-budget feat/budget-report","[\"feat/allowance-budget\",\"feat/budget-report\"]"]], every: true },
      ],
      requiredSkills: ["create-pr", "git-workflow"],
      requiredReferences: ["git-workflow/references/github-stacks.md"],
      requiredInspectionsBeforeActions: historyInspections.map(inspection => ({ inspection, action: "git.stackInit" as const })),
      requiredActions: ["git.stackInit", "git.stackSubmit", "forge.markPrReady"],
      // Every init adopts exactly the PR whose commits the branch contains, bottom to top.
      requiredActionsBeforeActions: [{ before: "git.stackInit", after: "git.stackSubmit" }],
      forbiddenActions: publication,
    },
  },
  {
    id: "create-pr-dependency-on-hand-based-pr-stops",
    description: "When the PR a change builds on is based by hand on another PR's branch instead of the default, publication stops and reports the topology rather than changing either PR.",
    prompt: "/create-pr for issue #121.",
    fixture: {
      environment: { orchestration: { endpoint: "deployed", entryPoints: "stop" } },
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
      rubric: [
        { id: "stopped-hand-based-120", question: "Does the answer state that publication stopped without opening or changing any PR because PR #120, whose commits this branch contains, is based on feat/budget-schema (PR #119's branch) rather than on main?" },
      ],
      requiredAnswerValues: [
        "120",
        ["budget-schema", "119"],
      ],
      requiredSkills: ["create-pr", "git-workflow"],
      requiredReferences: ["git-workflow/references/github-stacks.md"],
      requiredInspections: historyInspections,
      requiredAnyActions: ["user.ask", "report"],
      forbiddenActions: stopped,
    },
  },
  {
    id: "create-pr-dependency-on-fork-pr-stops",
    description: "A change that contains a fork PR's commits cannot stack on it, so publication stops and reports instead of opening an ordinary PR that carries those commits.",
    prompt: "/create-pr for issue #121.",
    fixture: {
      environment: { orchestration: { endpoint: "deployed", entryPoints: "stop" } },
      evidence: {
        ...common,
        openPullRequests: listing(pr(130, "main", budget, "main", true)),
        pullRequestHeads: `$ git fetch origin pull/130/head\n$ git rev-list origin/main..${budget}\n${budget}`,
        stackTopology: "gh stack view --json reports no locally tracked stack. GitHub reports no native stack. The official gh-stack extension is installed and authenticated.",
      },
    },
    expected: {
      rubric: [
        { id: "stopped-fork-130", question: "Does the answer state that publication stopped because this branch contains commits of fork (cross-repository) PR #130, which cannot serve as a stack base, instead of opening an ordinary PR that carries those commits?" },
      ],
      requiredAnswerValues: [
        "130",
      ],
      requiredSkills: ["create-pr"],
      requiredInspections: historyInspections,
      requiredAnyActions: ["user.ask", "report"],
      forbiddenActions: stopped,
    },
  },
  {
    id: "create-pr-unrelated-open-prs-publish-normally",
    description: "Open PRs that share no commits with the change, including a fork PR from a branch named main, leave an ordinary publication against the default branch.",
    prompt: "/create-pr for issue #121.",
    fixture: {
      environment: { orchestration: { endpoint: "deployed", entryPoints: "stop" } },
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
      rubric: [
        { id: "pr-122-ready", question: "Does the answer report that PR #122 for feat/budget-report is ready for review as an ordinary publication, rather than stopping or stacking because of PR #118 or fork PR #130?" },
      ],
      requiredAnswerValues: [
        "122",
      ],
      requiredActionValues: [
        { action: "forge.openDraftPr", values: ["main"], fields: ["base"], every: true },
      ],
      requiredSkills: ["create-pr"],
      requiredInspections: historyInspections,
      requiredActions: ["git.push", "forge.openDraftPr", "forge.markPrReady"],
      forbiddenActions: ["forge.mergePr", "git.amend", "git.forcePush", "git.rebase", "git.stackInit", "git.stackSubmit", "git.stackMerge", "user.ask"],
    },
  },
  {
    id: "create-pr-named-release-base-publishes-normally",
    description: "A backport onto a user-named release branch publishes as an ordinary PR against that branch, even while an open PR has the release branch as its head and an up-to-date default-branch PR shares a default commit the backport merged.",
    prompt: "/create-pr for issue #140. This is a backport onto release/1.x.",
    fixture: {
      environment: { orchestration: { endpoint: "deployed", entryPoints: "stop" } },
      evidence: {
        repositoryStatus: `Repository example/project on github.com. The clean current branch backport/retry-budget is at ${backport}, created from freshly fetched origin/release/1.x at ${release}. Freshly fetched origin/main is at ${main}. No unrelated local work.`,
        branchHistory: `$ git log --oneline HEAD ^origin/release/1.x\n5555555 fix(retry): bound the retry budget\n9999999 Merge the timeout hotfix from main\n8888888 fix(http): restore the request timeout\n$ git rev-list HEAD ^origin/release/1.x\n${backport}\n${mergeCommit}\n${hotfix}\n$ git rev-list HEAD ^origin/release/1.x ^origin/main\n${backport}\n${mergeCommit}\n$ git merge-base --is-ancestor ${hotfix} origin/main && echo on-main\non-main`,
        openPullRequests: listing(pr(150, "release/1.x", release), pr(160, "feat/export-csv", exportCsv)),
        pullRequestHeads: `$ git fetch origin pull/150/head pull/160/head\n$ git rev-list ${release} ^origin/release/1.x\n$ git rev-list ${exportCsv} ^origin/release/1.x\n${exportCsv}\n${main}\n${hotfix}\n$ git rev-list ${release} ^origin/release/1.x ^origin/main\n$ git rev-list ${exportCsv} ^origin/release/1.x ^origin/main\n${exportCsv}`,
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
      rubric: [
        { id: "pr-151-ready-on-release", question: "Does the answer report that backport PR #151 is ready for review as an ordinary PR against release/1.x, rather than stopping or stacking on PR #150 or PR #160?" },
      ],
      requiredAnswerValues: [
        "151",
        "release/1.x",
      ],
      requiredActionValues: [
        { action: "forge.openDraftPr", values: ["release/1.x"], fields: ["base"], every: true },
      ],
      requiredSkills: ["create-pr"],
      requiredInspections: historyInspections,
      requiredActions: ["git.push", "forge.openDraftPr", "forge.markPrReady"],
      // The base field is appended last, so the pattern checks that field rather than any mention of the branch.
      forbiddenActions: ["forge.mergePr", "git.amend", "git.forcePush", "git.rebase", "git.stackInit", "git.stackSubmit", "git.stackMerge", "user.ask"],
    },
  },
  {
    id: "update-pr-named-release-base-merges-that-base",
    description: "Updating a backport PR whose base is a documented release branch merges that branch, never the default branch.",
    prompt: "/update-pr 151.",
    fixture: {
      environment: { orchestration: { endpoint: "deployed", entryPoints: "stop" } },
      evidence: {
        repositoryStatus: `Repository example/project on github.com. The clean current branch backport/retry-budget is at ${backport}. It is one commit behind freshly fetched origin/release/1.x at ${releaseFix} and forty commits behind freshly fetched origin/main at ${main}. No unrelated local work and no conflicts.`,
        pullRequest: "PR #151 is open from backport/retry-budget into release/1.x. Its title and body match the change.",
        openPullRequests: listing(pr(151, "backport/retry-budget", backport, "release/1.x"), pr(160, "feat/export-csv", exportCsv)),
        stackTopology: "gh stack view --json reports no locally tracked stack. GitHub reports no native stack.",
        projectDefinitions: "CONTRIBUTING.md: fixes for the 1.x line land on the long-lived release/1.x branch through backport PRs. Issue #140 asks for the retry budget fix on the 1.x release line.",
        projectGate: "The declared gate must run after the merge.",
      },
      actionResponses: {
        "git.merge": "Merged cleanly.",
        "validation.run": "Declared aggregate gate passed on the merged head.",
        "git.push": "Normal push published backport/retry-budget.",
      },
    },
    expected: {
      rubric: [
        { id: "merges-release-base", question: "Does every recorded git.merge action merge release/1.x (the PR's base) into backport/retry-budget, with no merge of main or origin/main, before the gate and the push?" },
      ],
      requiredSkills: ["update-pr"],
      requiredActions: ["git.merge", "validation.run", "git.push"],
      // Every merge has to name the release branch; whether it is the operand rather than a mention is judged above.
      requiredActionValues: [{ action: "git.merge", values: [["release/1.x", "origin/release/1.x"]], every: true }],
      forbiddenActions: ["forge.mergePr", "git.amend", "git.forcePush", "git.rebase", "git.stackInit", "git.stackSubmit", "git.stackSync", "user.ask"],
    },
  },
  {
    id: "update-pr-hand-based-pr-stops",
    description: "Updating a PR whose base was set by hand to another PR's feature branch stops and reports the base instead of merging the default branch or that branch.",
    prompt: "/update-pr 122.",
    fixture: {
      environment: { orchestration: { endpoint: "deployed", entryPoints: "stop" } },
      evidence: {
        repositoryStatus: `Repository example/project on github.com. The clean current branch feat/budget-report is at ${report}. It is two commits behind freshly fetched origin/feat/allowance-budget at ${budget} and five commits behind freshly fetched origin/main at ${main}. No unrelated local work.`,
        pullRequest: "PR #122 is open from feat/budget-report into feat/allowance-budget.",
        openPullRequests: listing(pr(120, "feat/allowance-budget", budget), pr(122, "feat/budget-report", report, "feat/allowance-budget")),
        stackTopology: "gh stack view --json reports no locally tracked stack. GitHub reports no native stack.",
        projectDefinitions: "CONTRIBUTING.md documents no long-lived branch other than main. Issue #121 asks for the remaining allowance in the budget report.",
        projectGate: "The declared gate must run after any merge.",
      },
    },
    expected: {
      rubric: [
        { id: "stops-on-hand-set-base", question: "Does the answer report that it stopped because PR #122's base, feat/allowance-budget, is the head of open PR #120 and neither the default branch, a named base nor part of a native stack, rather than describing the PR as up to date?" },
      ],
      requiredAnswerValues: [["feat/allowance-budget", "120"]],
      requiredSkills: ["update-pr"],
      // Asking which base to use is a stop too; choosing one is not.
      forbiddenActions: [...stopped, "git.merge", "git.stackSync"],
    },
  },
  {
    id: "create-pr-named-base-dependency-on-default-pr-stops",
    description: "A backport onto a named release base that contains a default-branch PR's commits stops and reports instead of stacking the backport on the default trunk.",
    prompt: "/create-pr for issue #140. This is a backport onto release/1.x.",
    fixture: {
      environment: { orchestration: { endpoint: "deployed", entryPoints: "stop" } },
      evidence: {
        repositoryStatus: `Repository example/project on github.com. The clean current branch backport/retry-budget is at ${backport}, created from freshly fetched origin/release/1.x at ${release}. Freshly fetched origin/main is at ${main}. No unrelated local work.`,
        branchHistory: `$ git log --oneline HEAD ^origin/release/1.x ^origin/main\n5555555 fix(retry): bound the retry budget\n9999999 Merge feat/allowance-budget into backport/retry-budget\n1111111 feat(budget): add allowance budget\n$ git rev-list HEAD ^origin/release/1.x ^origin/main\n${backport}\n${mergeCommit}\n${budget}`,
        openPullRequests: listing(pr(120, "feat/allowance-budget", budget)),
        pullRequestHeads: `$ git fetch origin pull/120/head\n$ git rev-list ${budget} ^origin/release/1.x ^origin/main\n${budget}`,
        stackTopology: "gh stack view --json reports no locally tracked stack. GitHub reports no native stack for #120, which is not approved and has auto-merge disabled.",
        projectDefinitions: "Issue #140 asks for the retry budget fix on the 1.x release line. This branch's change completes #140.",
        completionEvidence: `Independent code review and real-interface behavior testing passed on exact head ${backport} for issue #140's claim.`,
        projectGate: `The declared gate passed on the unchanged head ${backport}.`,
        pullRequest: "No pull request exists for backport/retry-budget.",
      },
    },
    expected: {
      rubric: [
        { id: "stopped-default-pr-120", question: "Does the answer state that publication stopped (nothing pushed or published) because the release/1.x backport contains commits of PR #120, which is based on main (the default trunk) rather than release/1.x, so the backport cannot stack on it?" },
      ],
      requiredAnswerValues: [
        "120",
      ],
      requiredSkills: ["create-pr"],
      requiredInspections: historyInspections,
      requiredAnyActions: ["user.ask", "report"],
      forbiddenActions: stopped,
    },
  },
  {
    id: "create-pr-truncated-open-pr-list-stops",
    // Claude Code caps MCP tool output well below this 1000-row listing, so only Codex can read it live.
    models: ["codex:gpt-6-astra", "codex:gpt-6.1-sol"],
    description: "An open-PR listing that returns exactly its limit may be truncated, so publication does not proceed on it.",
    prompt: "/create-pr for issue #121.",
    fixture: {
      environment: { orchestration: { endpoint: "deployed", entryPoints: "stop" } },
      evidence: {
        ...common,
        // gh lists newest first, so the rows dropped past the limit are the oldest PRs.
        openPullRequests: listing(...Array.from({ length: 1000 }, (_, i) =>
          pr(5000 - i, `feat/change-${5000 - i}`, (5000 - i).toString(16).padStart(40, "c")))),
        stackTopology: "gh stack view --json reports no locally tracked stack.",
        continuousIntegration: `After publication, every check on exact head ${report} reaches a successful terminal result.`,
      },
    },
    expected: {
      rubric: [
        { id: "stopped-truncated-listing", question: "Does the answer state that publication stopped (nothing published) because the open-PR listing returned as many rows as its limit (1000), so it may be truncated or incomplete?" },
      ],
      requiredAnswerValues: [
        ["1000", "1,000"],
      ],
      requiredSkills: ["create-pr"],
      requiredInspections: ["openPullRequests"],
      requiredAnyActions: ["user.ask", "report"],
      forbiddenActions: stopped,
    },
  },
];
