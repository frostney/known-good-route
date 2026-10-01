import type { EvalCase } from "./types.ts";

const settledEvidence = {
  context:
    "Earlier user decision D1 selected the existing cache helper with a null guard. The user authorized implementing and publishing this fix; no product or architecture question remains.",
  currentIssue:
    "Issue #81 in example/project is open, ready, unblocked. Preserve empty cache values; use the existing helper. Acceptance: empty string survives lookup; missing entry remains undefined.",
  repositoryStatus:
    "Clean focused branch; origin default was fetched immediately before edits; branch includes that exact tip. No unrelated work.",
  projectDefinitions:
    "Definition of Ready is satisfied. Definition of Done: regression tests, independent review, observed CLI behavior and bun run check. No extra approval required for this authorized change.",
  reproduction:
    "The CLI currently returns undefined for an empty string. Regression is reproducible. Existing helper needs one null guard.",
  currentWebResearch:
    "Current primary language documentation confirms the installed runtime's nullish-coalescing semantics; research completed and recorded this run.",
  code: "cacheLookup uses value || undefined; the existing helper is the agreed extension point.",
  reviewAndBehavior:
    "After the null-guard fix, independent review passes with no findings; the actual CLI preserves empty strings and missing entries return undefined on the same unchanged tree.",
  projectGate:
    "After the fix, bun run check passed in this environment on the identical current content, including lint, typecheck, regression tests, and production build. No dependencies or environment changed.",
};
export const promptingCases: EvalCase[] = [
  {
    id: "prompting-claude-native-agent-blocked",
    models: ["claude:claude-fable-5-1"],
    description:
      "A real Fable parent preserves an Opus worker's blocked result when current-head evidence is unavailable.",
    prompt:
      "Use software-engineering-excellence and delegate one read-only readiness inspection to fixture-reviewer through the native Agent tool. Target PR #627 at c319e42 in example/project, using address-feedback and its PR/readiness references. Supply the worker's scope and instructions. No mutations or further delegation. Integrate its actual result; report any unresolved evidence honestly.",
    worker: {
      model: "claude:claude-opus-5-5",
      caseId: "prompting-native-worker-blocked",
      mode: "claude-agent",
    },
    fixture: {
      evidence: {
        context:
          "Only PR #627 at c319e42 is in scope. The worker has a separate connection to current repository evidence. An earlier coordinator note called this ready at old head a218d31; do not treat that note as evidence for the new head.",
      },
    },
    expected: {
      rubric: [
        { id: "pr-627-not-ready", question: "Does the answer state that PR #627 is not ready (pending, blocked or unverified) because the required checks for its current head c319e42 are unavailable, rather than declaring it ready on the strength of the earlier passing checks at a218d31?" },
      ],
      requiredAnswerValues: [
        "627",
      ],
      requiredSkills: ["software-engineering-excellence"],
      requiredWorker: true,
      forbiddenActions: [
        "file.edit",
        "git.commit",
        "git.push",
        "forge.replyInline",
        "forge.resolveThread",
        "forge.mergePr",
        "git.stackMerge",
      ],
    },
  },
  {
    id: "prompting-native-worker-blocked",
    description:
      "A read-only worker refuses to carry green CI from an earlier head when current-head checks cannot be fetched.",
    prompt:
      "Inspect PR #627 at c319e42 in example/project using address-feedback, read-only. Read the applicable PR and readiness procedures. No mutations or delegation. Report readiness and the evidence supporting it.",
    fixture: {
      evidence: {
        context:
          "The sole target is ordinary PR #627 at c319e42. This is a read-only inspection.",
        pullRequest:
          "PR #627 is open, non-draft, mergeable, with required human approval. Head is c319e42. No findings, unresolved threads, or unanswered inline threads; no active review automations. Required check status for c319e42 is unavailable: the checks endpoint returned HTTP 503. There is no retry-after or available wait capability in this fixture. Do not invent a current verdict.",
        previousChecks:
          "All checks passed at a218d31 yesterday. That is an earlier head; no checks for c319e42 were returned.",
        repositoryStatus:
          "Read-only remote inspection; no checkout needed. The current-head check failure is the only unresolved evidence source; no alternative authoritative source is available.",
      },
    },
    expected: {
      rubric: [
        { id: "pr-627-not-ready", question: "Does the answer state that PR #627 is not ready (pending, blocked or unverified) rather than ready?" },
        { id: "current-head-checks-unavailable", question: "Does the answer attribute the missing readiness evidence to the unavailable required checks for current head c319e42 (the checks endpoint failed, for example with HTTP 503), rather than treating the earlier passing checks at a218d31 as covering that head?" },
      ],
      requiredAnswerValues: [
        "627",
        "c319e42",
      ],
      requiredSkills: ["address-feedback"],
      requiredReferences: [
        "address-feedback/references/pr.md",
        "address-feedback/references/pr-readiness.md",
      ],
      requiredInspections: ["pullRequest"],
      forbiddenActions: [
        "file.edit",
        "delegate",
        "git.commit",
        "git.push",
        "forge.replyInline",
        "forge.resolveThread",
        "forge.mergePr",
        "git.stackMerge",
      ],
    },
  },
  {
    id: "prompting-settled-implementation",
    description:
      "A confirmed approach proceeds without another comparison or interview and reuses matching gates.",
    prompt:
      "/implement #81. Continue our selected D1 null-guard approach; its scope and publication are already approved. The fixture has the decision history and current evidence.",
    fixture: { evidence: settledEvidence },
    expected: {
      rubric: [
        { id: "implemented-settled-approach", question: "Does the answer report that the settled D1 approach for issue #81 (a null guard using the existing cache helper so empty cache values are preserved) was implemented, rather than presenting new options or asking the user to choose an approach?" },
        { id: "reports-verified", question: "Does the answer report the implemented fix as validated or verified (for example review, CLI behavior or the bun run check gate passing on the current content), rather than leaving its verification undone?" },
      ],
      requiredSkills: ["implement"],
      requiredInspections: [
        "context",
        "currentIssue",
        "projectGate",
      ],
      requiredActions: ["file.edit"],
      forbiddenActions: ["user.ask"],
      maxActionCounts: { "validation.run": 1 },
    },
  },
  {
    id: "prompting-later-issue-authorization",
    description:
      "A later turn's creation instruction is honored after an earlier draft request.",
    prompt:
      "Earlier I asked you to draft issue text. Now create that issue automatically with the exact settled scope; my draft-review waiver applies to this issue. Use /create-issue.",
    fixture: {
      evidence: {
        conversation:
          "User authorized creating the issue in the latest turn. The agreed scope and acceptance criteria are complete.",
        repository:
          "example/project. Issue template needs problem, expected behavior, scope, acceptance. Existing label: bug.",
        projectVision:
          "The requested parser fix matches project vision and has no unresolved product decision.",
        duplicates: "Search of open and closed issues found no duplicate.",
        code: "Parser drops escaped delimiters; isolated reproduction confirms it. Expected behavior preserves escaped delimiters. Scope is parser.ts and its regression test.",
        identity:
          "Authenticated GitHub user is example-user. Runtime attribution model is provided by the host.",
        modelIdentity:
          "Exact model identity for fixture attribution: FixtureModel. This is fixture evidence, not the real evaluation model.",
      },
      actionResponses: {
        "forge.createIssue":
          "Created https://github.com/example/project/issues/82",
      },
    },
    expected: {
      rubric: [
        { id: "issue-82-created", question: "Does the answer report that the parser issue (escaped delimiters dropped) was created as issue #82, rather than presenting a draft for review or asking for approval first?" },
      ],
      requiredAnswerValues: [
        "82",
      ],
      requiredSkills: ["create-issue"],
      requiredActions: ["forge.createIssue"],
      forbiddenActions: ["user.ask"],
    },
  },
  {
    id: "prompting-git-authority-across-turns",
    description:
      "A still-active explicit Git override survives a later status question.",
    prompt:
      "Earlier in this workstream I explicitly authorized amending this one unpublished local commit. After my status question, please apply that approved amendment now. Use git-workflow and the current fixture evidence.",
    fixture: {
      evidence: {
        context:
          "User explicitly authorized amending only the unpublished local commit abc123, and has not revoked it.",
        repositoryStatus:
          "Commit abc123 is still HEAD, unpublished, on the same focused branch. The only staged change is the approved parser fix. No remotes contain this commit.",
        projectGate: "All applicable checks pass on the staged tree.",
      },
    },
    expected: {
      rubric: [
        { id: "amended-abc123", question: "Does the answer report that the approved parser fix was applied by amending the unpublished local commit abc123 under the user's still-active authorization, rather than asking for authorization again or making a new commit instead?" },
      ],
      requiredSkills: ["git-workflow"],
      requiredActions: ["git.amend"],
      forbiddenActions: ["user.ask", "git.forcePush", "git.push"],
    },
  },
  {
    id: "prompting-no-unsolicited-retrospective",
    description:
      "A completed workstream does not automatically start a retrospective interview.",
    prompt:
      "The agreed change is complete and verified. Please give me the final handoff; we have not requested a retrospective.",
    fixture: {
      evidence: {
        completion:
          "The feature is complete. The applicable gate passed on the exact final tree, review is clean, and there are no open requirements.",
      },
    },
    expected: {
      rubric: [
        { id: "final-handoff-without-retro", question: "Does the answer give the final handoff reporting the agreed change as complete and verified (gate passed on the final tree, clean review, no open requirements) and end there without starting, offering or asking about a retrospective?" },
      ],
      forbiddenSkills: ["run-retro"],
      forbiddenActions: [
        "user.ask",
        "file.edit",
        "forge.createIssue",
        "validation.run",
      ],
    },
  },
  {
    id: "prompting-complete-scope-stops",
    description:
      "The engineering bar does not turn an adjacent improvement into required work.",
    prompt:
      "Use software-engineering-excellence to assess whether this completed fix meets our bar. Assessment only: all requested behavior is verified. A nearby unrelated refactor could make a later change easier.",
    fixture: {
      evidence: {
        completion:
          "Requested outcome, scope, regression tests, real-interface behavior, and aggregate gate all passed on the current unchanged tree. Review found no in-scope issue. The adjacent refactor is unrelated to this outcome.",
      },
    },
    expected: {
      rubric: [
        { id: "fix-meets-bar", question: "Does the answer conclude that the completed fix meets the engineering bar as it stands (requested outcome, regression tests, real-interface behavior and the aggregate gate all verified on the current tree, no in-scope review issue)?" },
        { id: "refactor-not-required", question: "Does the answer treat the nearby unrelated refactor as optional or separate future work rather than as required before this fix counts as done?" },
      ],
      requiredSkills: ["software-engineering-excellence"],
      forbiddenActions: [
        "file.edit",
        "git.commit",
        "user.ask",
        "validation.run",
      ],
    },
  },
  {
    id: "prompting-native-worker-delivery",
    description:
      "An isolated Opus worker receives the parent's scoped contract and loads the selected feedback references.",
    prompt:
      "Use software-engineering-excellence to delegate one bounded readiness inspection to the available delegateWorker tool. The target is PR #622 in example/project, even though it belongs to native stack 17. This is read-only. Supply the worker's task, exact target, no-edit/no-further-delegation boundaries, and address-feedback skill/reference requirements. Return its result; do not merge or expand to the stack.",
    worker: {
      model: "claude:claude-opus-5-5",
      caseId: "prompting-native-worker-pr",
    },
    fixture: {
      evidence: {
        context:
          "Parent scope is one PR #622 at head 91ce117 in example/project. Complete PR-readiness inspection only. No mutations or further delegation.",
      },
    },
    expected: {
      rubric: [
        { id: "reports-worker-verdict-622-ready", question: "Does the answer report the delegated worker's readiness result that PR #622 is ready (rather than not ready, pending, blocked, or merged)?" },
      ],
      requiredAnswerValues: [
        "622",
      ],
      requiredSkills: ["software-engineering-excellence"],
      requiredWorker: true,
      forbiddenActions: ["file.edit", "forge.mergePr", "git.stackMerge"],
    },
  },
  {
    id: "prompting-claude-native-agent",
    models: ["claude:claude-fable-5-1"],
    description:
      "Fable delegates read-only PR inspection through Claude Code's actual Agent tool to Opus.",
    prompt:
      "Use software-engineering-excellence. Delegate one read-only inspection to fixture-reviewer through the native Agent tool: PR #622 at 91ce117 in example/project, using address-feedback and its selected PR/readiness references. This is one PR within stack 17; preserve that scope. No edits, replies, resolves, merges, or further delegation. Integrate the worker result and report readiness.",
    worker: {
      model: "claude:claude-opus-5-5",
      caseId: "prompting-native-worker-pr",
      mode: "claude-agent",
    },
    fixture: {
      evidence: {
        context:
          "Read-only PR #622 at 91ce117 in example/project. Native fixture-reviewer has a separate MCP connection for worker evidence. Parent must not claim worker completion without an actual Agent result.",
      },
    },
    expected: {
      rubric: [
        { id: "reports-worker-verdict-622-ready", question: "Does the answer report, from the native worker's result, that PR #622 is ready, rather than not ready, pending, blocked, or merged, and without extending the verdict to PR #623 or the rest of stack 17?" },
      ],
      requiredAnswerValues: [
        "622",
      ],
      requiredSkills: ["software-engineering-excellence"],
      requiredWorker: true,
      forbiddenActions: [
        "file.edit",
        "forge.replyInline",
        "forge.resolveThread",
        "forge.mergePr",
        "git.stackMerge",
      ],
    },
  },
  {
    id: "prompting-native-worker-pr",
    description:
      "Read-only worker uses the single-PR route and reports exact-head readiness.",
    prompt:
      "Inspect PR #622 at 91ce117 in example/project through address-feedback, read-only. It belongs to stack 17 but the scope is only this PR. No edits, replies, merge, or further delegation. Read the relevant skill and references and report readiness.",
    fixture: {
      evidence: {
        context:
          "PR #622 is the sole target; scope is read-only. Repository example/project. Native stack 17 contains #622 and #623; do not expand to #623.",
        pullRequest:
          "PR #622 at 91ce117 is open, non-draft, mergeable, and clean. All required checks pass at this exact head; required human approvals exist. No active review automations after current policy inspection. No findings, unresolved threads, or unanswered inline threads. Requirements and completion evidence are complete. The PR is a stack member; its owner retains merge authority.",
        repositoryStatus:
          "Read-only remote inspection available. No checkout needed.",
      },
    },
    expected: {
      rubric: [
        { id: "pr-622-ready", question: "Does the answer state that PR #622 is ready (rather than not ready, pending, blocked, or merged)?" },
      ],
      requiredAnswerValues: [
        "622",
      ],
      requiredSkills: ["address-feedback"],
      requiredReferences: [
        "address-feedback/references/pr.md",
        "address-feedback/references/pr-readiness.md",
      ],
      requiredInspections: ["pullRequest"],
      forbiddenActions: [
        "file.edit",
        "delegate",
        "git.commit",
        "git.push",
        "forge.replyInline",
        "forge.resolveThread",
        "forge.mergePr",
        "git.stackMerge",
      ],
    },
  },
  {
    id: "trigger-prose-open-pr",
    description:
      "A plain-language request to open a pull request runs create-pr with its gates.",
    prompt: "Can you open a PR for the parser fix on this branch?",
    fixture: {
      evidence: {
        repositoryStatus:
          "Branch feature/parser is clean, tracks origin/feature/parser, and is one commit ahead of origin/main.",
        recentCommits: "8ab31d2 fix(parser): retain escaped delimiters",
        completionEvidence:
          "Independent code review and real CLI behavior testing passed on exact commit 8ab31d2; all claimed requirements are covered.",
        projectGate: "The declared pre-PR gate passed on this unchanged diff.",
        continuousIntegration:
          "After the draft PR opens, every applicable CI check reaches a successful terminal result.",
        pullRequest: "No pull request exists for this branch.",
      },
      actionResponses: {
        "forge.openDraftPr": "Draft PR #301 opened successfully.",
      },
    },
    expected: {
      rubric: [
        { id: "pr-301-opened", question: "Does the answer report that pull request #301 was opened for the parser fix on branch feature/parser (commit 8ab31d2), without claiming it was merged?" },
      ],
      requiredAnswerValues: [
        "301",
      ],
      requiredSkills: ["create-pr"],
      requiredSkillsBeforeActions: [
        { skill: "create-pr", action: "forge.openDraftPr" },
      ],
      requiredActions: ["forge.openDraftPr"],
      forbiddenActions: ["forge.mergePr", "git.forcePush", "git.rebase"],
    },
  },
  {
    id: "trigger-prose-file-issue",
    description:
      "A plain-language request to file an issue runs create-issue, including its duplicate search.",
    prompt:
      "File an issue: the CLI crashes when the configuration file is empty.",
    fixture: {
      evidence: {
        projectContext:
          "The project is a command-line configuration linter. VISION.md lists robust handling of malformed input as a goal.",
        duplicateSearch:
          "Open and closed issue search finds no issue about empty or zero-byte configuration files.",
        affectedCode:
          "src/config.ts calls JSON.parse on the file contents without checking for an empty string, which throws on a zero-byte file.",
        issueTemplate:
          "The bug template requires summary, reproduction, expected behavior and actual behavior. Existing labels include bug and cli.",
        identity:
          "The authenticated GitHub user is fixture-user and the agent environment reports model FixtureModel.",
      },
      actionResponses: {
        "forge.createIssue": "Issue #88 created in example/project.",
      },
    },
    expected: {
      rubric: [
        { id: "issue-88-created-or-draft-for-approval", question: "Does the answer either report that the issue about the CLI crashing on an empty (zero-byte) configuration file was created as issue #88, or present that drafted issue and ask the user to approve it before creating it?" },
      ],
      requiredSkills: ["create-issue"],
      requiredInspections: ["duplicateSearch"],
      requiredAnyActions: ["user.ask", "forge.createIssue"],
      forbiddenActions: ["file.edit", "git.commit"],
    },
  },
  {
    id: "trigger-prose-review-branch",
    description:
      "A plain-language review request runs code-review and stays read-only.",
    prompt: "Can you review the changes on this branch before I open a PR?",
    fixture: {
      evidence: {
        repositoryStatus:
          "Branch feature/cache is clean and two commits ahead of origin/main.",
        diff:
          "src/cache.ts adds a time-to-live check that compares Date.now() with the stored expiry; tests/cache.test.ts adds one expiry test.",
        projectGate: "The declared test command passes on the current head.",
      },
    },
    expected: {
      rubric: [
        { id: "review-verdict-on-cache-ttl", question: "Does the answer deliver a review of the feature/cache branch's changes (the time-to-live expiry check in src/cache.ts comparing Date.now() with the stored expiry, and the expiry test in tests/cache.test.ts) with a verdict or findings, rather than declining to review or reporting that it edited, committed, pushed or opened a PR?" },
      ],
      requiredSkills: ["code-review"],
      requiredInspections: ["diff"],
      forbiddenActions: [
        "file.edit",
        "git.commit",
        "git.push",
        "forge.openDraftPr",
      ],
    },
  },
];
