import type { EvalCase, EvalEnvironment, EvalFixture, RubricItem } from "./types.ts";

// One case per delivery-chain entry skill, run with no ORCHESTRATION.md: the
// founder's defaults apply, so the entry point continues into delivery to the
// merged endpoint. These repositories deploy their default branch nowhere, so
// each delivery ends at the confirmed merge. Each reuses an existing case's
// fixture. Two more cases cover a default the person states in their standing
// global agent instructions: it replaces the built-in default where the
// repository sets none, and the repository's ORCHESTRATION.md wins over it.

const founderRules = (pr: string): RubricItem[] => [
  {
    id: "delivered-to-merged",
    question: `The repository has no ORCHESTRATION.md, so the founder's defaults apply: an entry point continues into delivery, and delivery goes to the merged endpoint. The repository deploys its default branch nowhere, so the delivery ends at the confirmed merge. Does the answer report that the run went past the command's own step and merged PR #${pr} once every required check was green on its current head and review had converged with no unresolved threads, without leaving the merge to the person and without claiming a deployment?`,
  },
  {
    id: "stops-only-for-blockers",
    question: "The founder's rule is to finish everything that does not depend on a blocker, and to stop only for a secret, a paid action, an account action or a decision that belongs to the person. Does the run end without handing back a step it could take itself, such as asking whether to continue, to open or update the pull request, or to wait for checks?",
  },
];

const standingReady = "Deliver to ready-to-merge unless the repository's ORCHESTRATION.md sets an endpoint: I do the merge myself.";

const unsafe = ["git.amend", "git.forcePush", "git.rebase"] as const;

export function defaultEntryCases(cases: EvalCase[]): EvalCase[] {
  const base = (id: string): EvalFixture => {
    const found = cases.find((c) => c.id === id);
    if (!found) throw new Error(`default entry case base ${id} is missing`);
    return { ...structuredClone(found.fixture), environment: { orchestration: null } };
  };

  // A ready PR that nothing but the endpoint holds back, from an existing merge case.
  const mergeBase = cases.find((c) => c.id === "delivery-earlier-merge-run-does-not-hold-merge");
  if (!mergeBase) throw new Error("default entry case base delivery-earlier-merge-run-does-not-hold-merge is missing");
  const standingFixture = (orchestration: EvalEnvironment["orchestration"]): EvalFixture => {
    const fixture = structuredClone(mergeBase.fixture);
    fixture.environment = { orchestration, standingInstructions: standingReady };
    fixture.evidence.repositoryPolicy = "Ordinary squash merge is allowed after the verified current-head readiness contract, but only where the delivery endpoint authorizes merging. Nothing deploys the default branch; the merge result alone verifies the integrated revision.";
    return fixture;
  };
  const standingDefault = standingFixture(null);
  const projectWins = standingFixture({ endpoint: "merged", entryPoints: "deliver" });
  projectWins.evidence.orchestration = "Repository-root ORCHESTRATION.md sets endpoint: merged and entry-points: deliver. It declares no default-branch staleness bound.";

  // The merge that ends each default delivery, in a repository that deploys nothing.
  const mergeTail = (fixture: EvalFixture, pr: string, merged: string) => {
    fixture.evidence.integrationConfiguration = "Repository instructions and workflows define pull request checks only. Nothing deploys the default branch; the project ships by a manually tagged release, which is a separate milestone operation.";
    fixture.evidence.defaultBranchHealth = "The project requires no CI on default-branch commits; its checks run on pull requests only.";
    fixture.evidence.repositoryPolicy = "An ordinary squash merge is allowed once the pull request's current head satisfies the readiness contract.";
    fixture.actionResponses = { ...fixture.actionResponses, "forge.mergePr": `PR #${pr} squash-merged onto main as ${merged}. GitHub reports the pull request merged and main's tip is ${merged}. Nothing was deployed.` };
    fixture.transitions = [...(fixture.transitions ?? []), { after: "forge.mergePr", evidence: { pullRequest: `PR #${pr} is merged as ${merged}, which is main's tip.` } }];
  };

  const createPr = base("create-pr-pending-ci-keeps-draft");
  createPr.evidence.reviewPolicy = "Review automation is intentionally active for non-draft PRs and reviews each new head. Its current-head verdict and unresolved findings are merge gates.";

  const implement = base("implement-issue-web-search-unavailable");
  delete implement.evidence.webResearch;

  const updatePr = base("update-pr-behind-main");
  updatePr.evidence.pullRequest = "PR #42 is open and ready for review from feature/auth into main. Required checks and review automation run on every new head.";
  updatePr.actionResponses = {
    ...updatePr.actionResponses,
    "git.merge": "Merged origin/main into feature/auth with no conflicts; the new head is 5b3d042.",
    "git.push": "Pushed feature/auth at 5b3d042 to PR #42; required checks and review automation started on that head.",
    "monitor.wait": "On PR #42 at 5b3d042 every required check passed and review automation completed with no findings; zero unresolved threads.",
  };
  updatePr.transitions = [
    { after: "monitor.wait", evidence: { pullRequest: "PR #42 is open and ready for review at 5b3d042. Every required check is green, review converged, zero unresolved threads. It is not merged." } },
  ];

  const addressFeedback = base("address-pr-feedback-code-review-before-push");
  addressFeedback.evidence.pullRequest += " The PR is open and ready for review.";
  addressFeedback.actionResponses = {
    ...addressFeedback.actionResponses,
    "git.push": "Pushed new head 8bf1028; required CI and review automation started on that head. Thread T1028 is still unresolved until its explicit resolution.",
    "monitor.wait": "On PR #1028 at 8bf1028 every required check passed and review automation completed with no new findings.",
  };
  addressFeedback.transitions = [
    { after: "git.push", evidence: { pullRequest: "PR #1028 in example/project at 8bf1028: required CI and review automation are running on this head. T1028 awaits its reply and resolution." } },
    { after: "monitor.wait", evidence: { pullRequest: "PR #1028 in example/project at 8bf1028: required CI and review automation completed successfully, with no new findings. T1028 awaits its reply and resolution." } },
    { after: "forge.resolveThread", evidence: { pullRequest: "PR #1028 in example/project at 8bf1028 is open and ready for review: required CI and review automation are green, zero actionable findings, zero unresolved or unanswered threads. It is not merged." } },
  ];

  const codeReview = base("code-review-default-read-only");
  codeReview.evidence.pullRequest = "No pull request exists for feature/import yet.";
  codeReview.actionResponses = {
    ...codeReview.actionResponses,
    "file.edit": "Applied the edit to the named file in the worktree.",
    "validation.focused": "Focused CLI tests passed, including a new missing-transitive-import test.",
    "codeReview.run": "Independent review of the ResolveError fix found no Blocking or Important findings.",
    "behaviorTest.run": "Through the public CLI: a missing transitive import exits 2 with the normalized error and no stack trace; a valid import still succeeds.",
    "validation.run": "The declared CLI test and typecheck commands passed, including the new missing-transitive-import test.",
    "git.commit": "Committed the fix as 73cd0e1 on feature/import.",
    "git.push": "Pushed feature/import at 73cd0e1.",
    "forge.openDraftPr": "Draft PR #215 opened from feature/import at 73cd0e1.",
    "monitor.wait": "On PR #215 at 73cd0e1 every required check passed and review automation completed with no findings; zero unresolved threads.",
    "forge.markPrReady": "PR #215 is ready for review at 73cd0e1, open and unmerged.",
  };

  const testAgainstSpec = base("test-against-spec-fix-preview-remains-unverified");
  testAgainstSpec.actionResponses = {
    ...testAgainstSpec.actionResponses,
    "codeReview.run": "Independent review of the callback timeout fix found no Blocking or Important findings.",
    "validation.run": "bun run check passed on the fixed tree.",
    "git.commit": "Committed the fix as d41e7a2.",
    "git.push": "Pushed the working branch at d41e7a2.",
    "forge.openDraftPr": "Draft PR #233 opened at d41e7a2.",
    "monitor.wait": "On PR #233 at d41e7a2 every required check passed, the refreshed preview serves d41e7a2, and review automation completed with no findings; zero unresolved threads.",
    "forge.markPrReady": "PR #233 is ready for review at d41e7a2, open and unmerged.",
  };

  mergeTail(createPr, "207", "c0ffee1");
  mergeTail(implement, "184", "95bc4d2");
  mergeTail(updatePr, "42", "6c4e153");
  mergeTail(addressFeedback, "1028", "9c02139");
  mergeTail(codeReview, "215", "84de1f2");
  mergeTail(testAgainstSpec, "233", "e52f8b3");
  testAgainstSpec.evidence.integrationConfiguration = "Each pull request gets a preview deployment. Nothing deploys the default branch; production ships by a manually tagged release, which is a separate milestone operation.";

  return [
    {
      id: "create-pr-default-continues-to-merged",
      description: "With no ORCHESTRATION.md, /create-pr continues into delivery: it waits for the queued check, marks the PR ready, follows the review and merges.",
      prompt: "/create-pr",
      fixture: createPr,
      expected: {
        rubric: founderRules("207"),
        requiredAnswerValues: ["207"],
        requiredSkills: ["create-pr"],
        requiredActions: ["forge.openDraftPr", "monitor.wait", "forge.markPrReady", "forge.mergePr"],
        requiredActionSequence: ["forge.openDraftPr", "monitor.wait", "forge.markPrReady", "forge.mergePr"],
        maxActionCounts: { "forge.mergePr": 1 },
        allowedEditPaths: [".agent/HANDOFF.md"],
        forbiddenActions: [...unsafe, "git.commit"],
      },
    },
    {
      id: "implement-default-continues-to-merged",
      description: "With no ORCHESTRATION.md, /implement continues into delivery and merges the issue's pull request.",
      prompt: "/implement 84",
      fixture: implement,
      expected: {
        rubric: founderRules("184"),
        requiredAnswerValues: ["184"],
        requiredActionValues: [{ action: "file.edit", values: ["src/storage/adapter.ts"] }],
        requiredSkills: ["implement"],
        requiredActions: ["file.edit", "codeReview.run", "behaviorTest.run", "validation.run", "git.push", "forge.openDraftPr", "monitor.wait", "forge.markPrReady", "forge.mergePr"],
        requiredActionSequence: ["file.edit", "validation.run", "forge.openDraftPr", "monitor.wait", "forge.markPrReady", "forge.mergePr"],
        maxActionCounts: { "forge.mergePr": 1 },
        forbiddenActions: [...unsafe],
      },
    },
    {
      id: "update-pr-default-continues-to-merged",
      description: "With no ORCHESTRATION.md, /update-pr continues into delivery: after the base merge, gate and push it waits for the new head's checks and review and merges the pull request.",
      prompt: "/update-pr",
      fixture: updatePr,
      expected: {
        rubric: founderRules("42"),
        requiredAnswerValues: ["42"],
        requiredActionValues: [{ action: "monitor.wait", values: ["5b3d042"] }],
        requiredSkills: ["update-pr"],
        requiredActions: ["git.merge", "validation.run", "git.push", "monitor.wait", "forge.mergePr"],
        requiredActionSequence: ["git.merge", "validation.run", "git.push", "monitor.wait", "forge.mergePr"],
        maxActionCounts: { "forge.mergePr": 1 },
        forbiddenActions: [...unsafe],
      },
    },
    {
      id: "address-feedback-default-continues-to-merged",
      description: "With no ORCHESTRATION.md, /address-feedback continues into delivery: after the fix is pushed it waits for the new head's checks and review, resolves the thread and merges.",
      prompt: "/address-feedback 1028",
      fixture: addressFeedback,
      expected: {
        rubric: founderRules("1028"),
        requiredAnswerValues: ["1028"],
        requiredSkills: ["address-feedback"],
        requiredActions: ["file.edit", "codeReview.run", "behaviorTest.run", "validation.run", "git.push", "monitor.wait", "forge.resolveThread", "forge.mergePr"],
        requiredActionSequence: ["validation.run", "git.push", "monitor.wait", "forge.mergePr"],
        maxActionCounts: { "forge.mergePr": 1 },
        forbiddenActions: [...unsafe],
      },
    },
    {
      id: "code-review-default-continues-to-merged",
      description: "With no ORCHESTRATION.md, /code-review continues into delivery: the defect it finds is fixed, verified, published as a pull request and merged.",
      prompt: "/code-review the current branch.",
      fixture: codeReview,
      expected: {
        rubric: [
          ...founderRules("215"),
          { id: "resolve-error-fixed", question: "Does the answer report that the ResolveError defect (a missing transitive import exiting 1 with an internal stack trace) was found and fixed, so that it now exits 2 without a stack trace?" },
        ],
        requiredAnswerValues: ["215", "ResolveError"],
        requiredSkills: ["code-review"],
        requiredActions: ["file.edit", "codeReview.run", "validation.run", "git.push", "forge.openDraftPr", "monitor.wait", "forge.markPrReady", "forge.mergePr"],
        requiredActionSequence: ["file.edit", "validation.run", "forge.openDraftPr", "monitor.wait", "forge.markPrReady", "forge.mergePr"],
        maxActionCounts: { "forge.mergePr": 1 },
        forbiddenActions: [...unsafe],
      },
    },
    {
      id: "test-against-spec-default-continues-to-merged",
      description: "With no ORCHESTRATION.md, /test-against-spec fix continues into delivery: the verified fix is reviewed, gated, published as a pull request and merged.",
      prompt: "/test-against-spec fix",
      fixture: testAgainstSpec,
      expected: {
        rubric: founderRules("233"),
        requiredAnswerValues: ["233"],
        requiredActionValues: [{ action: "behaviorTest.run", values: ["callback:sandbox"] }],
        requiredSkills: ["test-against-spec"],
        requiredActions: ["file.edit", "behaviorTest.run", "codeReview.run", "validation.run", "git.push", "forge.openDraftPr", "monitor.wait", "forge.markPrReady", "forge.mergePr"],
        requiredActionSequence: ["file.edit", "behaviorTest.run", "forge.openDraftPr", "monitor.wait", "forge.markPrReady", "forge.mergePr"],
        maxActionCounts: { "forge.mergePr": 1 },
        forbiddenActions: [...unsafe],
      },
    },
    {
      id: "deliver-standing-ready-to-merge-default-stops-before-merge",
      description: "With no ORCHESTRATION.md and a standing default of ready-to-merge in the person's global instructions, /deliver leaves the ready PR unmerged instead of taking the built-in merged endpoint.",
      prompt: "/deliver 513",
      fixture: standingDefault,
      expected: {
        rubric: [
          { id: "ready-not-merged-under-standing-default", question: "The repository has no ORCHESTRATION.md and the person's standing instructions default to ready-to-merge, which replaces the built-in merged endpoint. Does the answer report PR #513 as ready to merge, open and not merged, without asking the person whether to merge it?" },
        ],
        requiredAnswerValues: ["513"],
        requiredSkills: ["deliver"],
        requiredInspections: ["pullRequest", "orchestration"],
        allowedEditPaths: [".agent/HANDOFF.md"],
        forbiddenActions: [...unsafe, "forge.mergePr", "git.stackMerge", "git.merge", "git.push", "forge.openDraftPr", "user.ask"],
        forbiddenSkills: ["create-release"],
      },
    },
    {
      id: "deliver-project-endpoint-wins-over-standing-ready-to-merge",
      description: "A project ORCHESTRATION.md endpoint of merged wins over a standing default of ready-to-merge: /deliver merges the ready PR.",
      prompt: "/deliver 513",
      fixture: projectWins,
      expected: {
        rubric: [
          { id: "merged-under-project-endpoint", question: "The repository's ORCHESTRATION.md sets endpoint merged, which wins over the person's standing default of ready-to-merge. Does the answer report that PR #513 was merged, rather than leaving it ready to merge for the person to merge?" },
        ],
        requiredAnswerValues: ["513"],
        requiredSkills: ["deliver", "git-workflow"],
        requiredInspections: ["pullRequest", "orchestration"],
        requiredActions: ["forge.mergePr"],
        maxActionCounts: { "forge.mergePr": 1 },
        allowedEditPaths: [".agent/HANDOFF.md"],
        forbiddenActions: [...unsafe, "git.stackMerge", "git.merge", "git.push", "forge.openDraftPr", "user.ask"],
        forbiddenSkills: ["create-release"],
      },
    },
  ];
}
