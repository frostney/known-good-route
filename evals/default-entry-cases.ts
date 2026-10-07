import type { EvalCase, EvalFixture, RubricItem } from "./types.ts";

// One case per delivery-chain entry skill, run with no ORCHESTRATION.md: the
// founder's defaults apply, so the entry point continues into delivery and
// stops at ready-to-merge. Each reuses an existing case's fixture.

const founderRules = (pr: string): RubricItem[] => [
  {
    id: "delivered-to-ready-to-merge",
    question: `The repository has no ORCHESTRATION.md, so the founder's defaults apply: an entry point continues into delivery, and delivery goes to the ready-to-merge endpoint. Does the answer report that the run went past the command's own step and left PR #${pr} ready to merge: open, ready for review, every required check green on its current head, review converged with no unresolved threads, and not merged?`,
  },
  {
    id: "stops-only-for-blockers",
    question: "The founder's rule is to finish everything that does not depend on a blocker, and to stop only for a secret, a paid action, an account action or a decision that belongs to the person. Does the run end without handing back a step it could take itself, such as asking whether to continue, to open or update the pull request, or to wait for checks?",
  },
];

const unsafe = ["forge.mergePr", "git.amend", "git.forcePush", "git.rebase"] as const;

export function defaultEntryCases(cases: EvalCase[]): EvalCase[] {
  const base = (id: string): EvalFixture => {
    const found = cases.find((c) => c.id === id);
    if (!found) throw new Error(`default entry case base ${id} is missing`);
    return { ...structuredClone(found.fixture), environment: { orchestration: null } };
  };

  const createPr = base("create-pr-pending-ci-keeps-draft");

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

  return [
    {
      id: "create-pr-default-continues-to-ready-to-merge",
      description: "With no ORCHESTRATION.md, /create-pr continues into delivery: it waits for the queued check, marks the PR ready and follows the review to ready-to-merge.",
      prompt: "/create-pr",
      fixture: createPr,
      expected: {
        rubric: founderRules("207"),
        requiredAnswerValues: ["207"],
        requiredSkills: ["create-pr"],
        requiredActions: ["forge.openDraftPr", "monitor.wait", "forge.markPrReady"],
        requiredActionSequence: ["forge.openDraftPr", "monitor.wait", "forge.markPrReady"],
        allowedEditPaths: [".agent/HANDOFF.md"],
        forbiddenActions: [...unsafe, "git.commit"],
      },
    },
    {
      id: "implement-default-continues-to-ready-to-merge",
      description: "With no ORCHESTRATION.md, /implement continues into delivery and leaves the issue's pull request ready to merge.",
      prompt: "/implement 84",
      fixture: implement,
      expected: {
        rubric: founderRules("184"),
        requiredAnswerValues: ["184"],
        requiredActionValues: [{ action: "file.edit", values: ["src/storage/adapter.ts"] }],
        requiredSkills: ["implement"],
        requiredActions: ["file.edit", "codeReview.run", "behaviorTest.run", "validation.run", "git.push", "forge.openDraftPr", "monitor.wait", "forge.markPrReady"],
        requiredActionSequence: ["file.edit", "validation.run", "forge.openDraftPr", "monitor.wait", "forge.markPrReady"],
        forbiddenActions: [...unsafe],
      },
    },
    {
      id: "update-pr-default-continues-to-ready-to-merge",
      description: "With no ORCHESTRATION.md, /update-pr continues into delivery: after the merge, gate and push it waits for the new head's checks and review.",
      prompt: "/update-pr",
      fixture: updatePr,
      expected: {
        rubric: founderRules("42"),
        requiredAnswerValues: ["42"],
        requiredActionValues: [{ action: "monitor.wait", values: ["5b3d042"] }],
        requiredSkills: ["update-pr"],
        requiredActions: ["git.merge", "validation.run", "git.push", "monitor.wait"],
        requiredActionSequence: ["git.merge", "validation.run", "git.push", "monitor.wait"],
        forbiddenActions: [...unsafe],
      },
    },
    {
      id: "address-feedback-default-continues-to-ready-to-merge",
      description: "With no ORCHESTRATION.md, /address-feedback continues into delivery: after the fix is pushed it waits for the new head's checks and review and resolves the thread.",
      prompt: "/address-feedback 1028",
      fixture: addressFeedback,
      expected: {
        rubric: founderRules("1028"),
        requiredAnswerValues: ["1028"],
        requiredSkills: ["address-feedback"],
        requiredActions: ["file.edit", "codeReview.run", "behaviorTest.run", "validation.run", "git.push", "monitor.wait", "forge.resolveThread"],
        requiredActionSequence: ["validation.run", "git.push", "monitor.wait"],
        forbiddenActions: [...unsafe],
      },
    },
    {
      id: "code-review-default-continues-to-ready-to-merge",
      description: "With no ORCHESTRATION.md, /code-review continues into delivery: the defect it finds is fixed, verified and published as a pull request that is ready to merge.",
      prompt: "/code-review the current branch.",
      fixture: codeReview,
      expected: {
        rubric: [
          ...founderRules("215"),
          { id: "resolve-error-fixed", question: "Does the answer report that the ResolveError defect (a missing transitive import exiting 1 with an internal stack trace) was found and fixed, so that it now exits 2 without a stack trace?" },
        ],
        requiredAnswerValues: ["215", "ResolveError"],
        requiredSkills: ["code-review"],
        requiredActions: ["file.edit", "codeReview.run", "validation.run", "git.push", "forge.openDraftPr", "monitor.wait", "forge.markPrReady"],
        requiredActionSequence: ["file.edit", "validation.run", "forge.openDraftPr", "monitor.wait", "forge.markPrReady"],
        forbiddenActions: [...unsafe],
      },
    },
    {
      id: "test-against-spec-default-continues-to-ready-to-merge",
      description: "With no ORCHESTRATION.md, /test-against-spec fix continues into delivery: the verified fix is reviewed, gated and published as a pull request that is ready to merge.",
      prompt: "/test-against-spec fix",
      fixture: testAgainstSpec,
      expected: {
        rubric: founderRules("233"),
        requiredAnswerValues: ["233"],
        requiredActionValues: [{ action: "behaviorTest.run", values: ["callback:sandbox"] }],
        requiredSkills: ["test-against-spec"],
        requiredActions: ["file.edit", "behaviorTest.run", "codeReview.run", "validation.run", "git.push", "forge.openDraftPr", "monitor.wait", "forge.markPrReady"],
        requiredActionSequence: ["file.edit", "behaviorTest.run", "forge.openDraftPr", "monitor.wait", "forge.markPrReady"],
        forbiddenActions: [...unsafe],
      },
    },
  ];
}
