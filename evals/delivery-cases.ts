import type { ActionName, EvalCase } from "./types.ts";

// Decision fixtures for the September 14 delivery contract. These responses
// simulate repository outcomes; they do not execute a deployment or release.
const unsafeGit: ActionName[] = ["git.amend", "git.rebase", "git.forcePush"];
const releaseActions: ActionName[] = ["forge.createRelease", "git.pushTag"];
const noPublication: ActionName[] = [
  ...unsafeGit, ...releaseActions, "git.push", "git.stackSubmit",
  "git.stackMerge", "forge.openDraftPr", "forge.mergePr", "forge.markPrReady",
];
const before = "1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a";
const candidate = "2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b";
const integrated = "3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c";
const delegatedHead = "5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e";
const redTip = "6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f";
const repairTip = "7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
const repairHead = "8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b";
const repairMerged = "9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c";
const repairReview = "Independent review of the tests/paths.test.ts correction against the macOS failure found no findings.";
const repairGate = "pnpm check passed on the corrected tree, including tests/paths.test.ts in a case-sensitive temporary directory.";
const greenTip = "e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1";
const parallelTip = "0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d";
const samplerTip = "5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a";
const stackHeads = ["c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1", "c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2", "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3"] as const;
// main is green by its newest concluded run; a parallel delivery's merge has a run in progress.
const greenMainWithRunInProgress = `The main tip is ${parallelTip}, the squash merge of PR #514 that a parallel delivery landed minutes ago; its push CI run is in progress and takes about 70 minutes. The newest concluded main run, for ${greenTip}, the commit just before it, succeeded in every required job; ${greenTip} landed 40 minutes ago. CI cancels an in-progress main run when a newer commit lands on main; no main run has been cancelled since ${greenTip}.`;
const common = {
  projectInstructions: "Fixture repository example/palette. Use its existing project commands. The supplied source, specification and workflow facts are current; no external research-dependent choice or mandatory delegation exists. No native stack. All operations are isolated fixture actions.",
  repositoryStatus: `Clean focused branch fix/selected-state at ${before}, ahead of and synchronized with freshly fetched origin/main. Its target, scope and implementation approach are settled. No unrelated local changes.`,
  relatedWork: "The exact repository, selected work item and open/closed issue search are verified. No duplicate work or competing branch exists.",
  media: "No new media is needed: the relevant before/after images and narrated, subtitled walkthrough already match the final intended scenario and are reviewer-accessible. Media is not a project readiness gate.",
};
const repaired = {
  "file.edit": "Applied the submitted scoped correction; the working tree now implements the supplied requirement. Only the named source and regression files changed.",
  "validation.focused": "The focused regression passes on the corrected working tree.",
  "codeReview.run": "Independent review of the corrected complete diff against the supplied requirements found no unresolved requirement, fidelity or regression findings.",
  "behaviorTest.run": "Observed the required success, failure and rendered acceptance paths through the current interface; all match the supplied contract.",
  "validation.run": "The declared aggregate project gate passed on the corrected unchanged content, after the supplied review and behavior checks.",
  "git.commit": `Committed the relevant correction as ${candidate}; the worktree is clean.`,
  "git.push": `Normal push succeeded at ${candidate}; the same branch remains the work item's branch.`,
} as const;
const gateSkills = ["code-review", "test-against-spec"];
const correctedImportBehavior = "Observed built CLI: absent input returns exit 2 with JSON code MissingFile; valid input retains its successful result. Both required paths pass on the corrected content.";
const publishedRelease = `The release workflow passed. Tag v4.2.0 targets ${integrated}; GitHub release https://github.com/example/palette/releases/tag/v4.2.0 is published with its signed archive, and package version 4.2.0 is present in the configured registry.`;
const validatedLedger = "Persisted the normalized milestone event ledger, then validated and summarized that same ledger successfully. Required event fields and span accounting are valid; unavailable usage fields are explicitly identified.";

// Capability-tier fixtures: a coordinator records each lane's tier in its packet,
// and a lane that meets work above that tier stops and returns its finding.
const tierBehind = "d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4";
const tierMain = "e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5";
const tierMerged = "f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6";
const tierFixed = "a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7";
const tierLanes = "The host supports context-isolated worker lanes with the same installed skills as this session. Each machine maps capability tiers to models in its own agent configuration. A lane receives only the packet the coordinator writes.";
const noTierPolicy = "No repository-root ORCHESTRATION.md exists, so no repository narrowing of the capability tiers applies.";
const tierReference = "milestone-rush/references/orchestration.md";
const appendOnlyMerge = `Merging origin/main at ${tierMain} into feat/retry-budget conflicts only in CHANGELOG.md and docs/decisions.md. Both are append-only: each side added entries at the end, and keeping both sides' entries in order resolves them. No source, test or configuration file conflicts.`;
const timeoutFailure = `Required check test (ubuntu) failed at ${tierMerged}: tests/export.test.ts "streams large exports" timed out after 5000 ms. The same test passed at ${tierBehind}. GitHub offers a re-run of the failed job.`;
const boundedClean = "Independent review of the complete diff against DEC-152 found no findings: every rendered selected-month label uses titleCaseLabel, including the compact table header.";
const boundedGate = "pnpm check passed on the current tree, including the selected-month label regressions.";
const boundedBehavior = "Observed the chart: selecting April shows the label April, matching the approved reference.";

export const deliveryCases: EvalCase[] = [
  {
    id: "delivery-implement-development-only",
    description: "Standalone implementation completes the specified development and fidelity work without entering publication.",
    prompt: "/implement 81",
    fixture: {
      environment: { orchestration: { endpoint: "deployed", entryPoints: "stop" } },
      evidence: { ...common,
        workItem: "Open issue #81 is implementation-ready. Its approved scope is preserving the selected month across chart/table changes, with the selected label matching the supplied title-case reference. No other behavior or design choice is open.",
        source: "src/report.ts currently resets month to January during switchView and renders the selected label in uppercase. The existing keepSelection helper and titleCaseLabel formatter provide the intended behavior. tests/report.test.ts is the existing regression home.",
        specification: "Selecting April, switching chart to table and back must retain April; the rendered label must read April, matching the approved reference. Both behavior and visual fidelity are required. The prior visual note was labeled low severity; it remains a requirement gap.",
        completionEvidence: "No current independent review, interface acceptance result or project gate exists for this change.",
        projectGate: "pnpm check is the declared local gate. The local browser preview and existing fixture data are available for acceptance checks; no deployment is needed to observe them.",
      },
      actionResponses: repaired,
    },
    expected: {
      rubric: [
        { id: "development-complete-unpublished", question: "Does the answer report that the issue #81 development work (keeping the selected month April across chart/table switching and rendering the selected label as title-case 'April' to match the reference) is complete, without claiming that it was pushed, published as a PR, or merged?" },
        { id: "behavior-test-covers-april-chart-table-label", question: "Does at least one recorded behaviorTest.run action describe checking the April selection across the chart and table views together with the selected label's fidelity to the reference (title-case label)?" },
      ],
      requiredSkills: ["implement", ...gateSkills],
      requiredInspections: ["workItem", "source", "specification"],
      requiredActions: ["file.edit", "codeReview.run", "behaviorTest.run", "validation.run"],
      requiredCurrentGates: {
        before: ["validation.run"],
        gates: [
          { action: "codeReview.run", result: repaired["codeReview.run"] },
          { action: "behaviorTest.run", result: repaired["behaviorTest.run"] },
        ],
        ignoreEditPaths: [".agent/HANDOFF.md"],
      },
      allowedEditPaths: ["src/report.ts", "tests/report.test.ts", ".agent/HANDOFF.md"],
      forbiddenActions: [...noPublication, "user.ask", "forge.createIssue"],
      forbiddenSkills: ["deliver", "create-pr", "create-release"],
    },
  },
  {
    id: "delivery-create-pr-missing-gates-repair",
    description: "PR creation obtains missing independent gates, repairs a discovered requirement gap and finishes ready for review.",
    prompt: "/create-pr for the import-error correction in the current branch.",
    fixture: {
      environment: { orchestration: { endpoint: "deployed", entryPoints: "stop" } },
      evidence: { ...common,
        specification: "Issue #82 requires the import CLI to return exit 2 and JSON code MissingFile for an absent input, while retaining successful imports. The current branch contains an attempted fix. No unresolved product decision exists.",
        source: "The attempted correction is in src/import.ts, with coverage in tests/import.test.ts. Both files and the built CLI are available to independent review and interface testing. The author has not supplied a validated correctness verdict.",
        completionEvidence: "Only a developer's summary is supplied. Independent code review, real CLI acceptance and the declared project gate have not run on this change.",
        projectGate: "pnpm check is the declared aggregate gate. The built import CLI can be exercised locally with an existing valid fixture and a missing pathname.",
        pullRequest: "No PR exists for this branch. The explicit PR template requires a concise summary and Closes #82. After creation, the metadata can be inspected here.",
        continuousIntegration: "PR checks have not been created yet.",
      },
      actionResponses: {
        ...repaired,
        "codeReview.run": "Independent review found the required absent-input path still returns generic Failure with exit 1. Correct src/import.ts and its existing regression; this is a verified issue #82 requirement gap. No unrelated findings.",
        "behaviorTest.run": "Observed the current built CLI: absent input returns generic Failure with exit 1, violating issue #82. The valid fixture succeeds. The missing-input path in src/import.ts and its existing regression need correction.",
        "forge.openDraftPr": `Created draft https://github.com/example/palette/pull/502 at ${candidate}; submitted body links issue #82.`,
        "monitor.wait": `All required PR #502 checks passed on ${candidate}.`,
        "forge.markPrReady": `PR #502 is ready for review at ${candidate}, open and unmerged.`,
      },
      transitions: [
        { after: "file.edit", editPath: "src/import.ts", evidence: {}, actionResponses: {
          "codeReview.run": repaired["codeReview.run"],
          "behaviorTest.run": correctedImportBehavior,
        } },
        { after: "forge.openDraftPr", evidence: { pullRequest: `Draft PR #502 is open at ${candidate}. Diff and submitted metadata match issue #82; no extra publication requirement exists.` } },
        { after: "monitor.wait", evidence: { continuousIntegration: `All required PR #502 checks passed on ${candidate}.` } },
      ],
    },
    expected: {
      rubric: [
        { id: "pr-502-ready-for-review", question: "Does the answer report that PR #502 is ready for review (open and unmerged, with its required checks passed), rather than still a draft, blocked, or merged?" },
        { id: "missing-file-gap-corrected", question: "Does the answer report that the issue #82 requirement gap in the import CLI (an absent input must return exit 2 with JSON code MissingFile; review/testing found it still returned a generic Failure with exit 1) was corrected before the PR was made ready?" },
      ],
      requiredAnswerValues: [
        "502",
      ],
      requiredSkills: ["create-pr", ...gateSkills],
      requiredInspections: ["specification", "completionEvidence"],
      requiredActions: ["file.edit", "codeReview.run", "behaviorTest.run", "validation.run", "forge.openDraftPr", "monitor.wait", "forge.markPrReady"],
      requiredActionSequence: ["file.edit", "forge.openDraftPr", "monitor.wait", "forge.markPrReady"],
      requiredCurrentGates: {
        before: ["git.push", "forge.openDraftPr", "forge.markPrReady"],
        gates: [
          { action: "codeReview.run", result: repaired["codeReview.run"] },
          { action: "behaviorTest.run", result: correctedImportBehavior },
          { action: "validation.run", result: repaired["validation.run"] },
        ],
        ignoreEditPaths: [".agent/HANDOFF.md"],
      },
      maxActionCounts: { "forge.openDraftPr": 1 },
      allowedEditPaths: ["src/import.ts", "tests/import.test.ts", ".agent/HANDOFF.md"],
      forbiddenActions: [...unsafeGit, ...releaseActions, "forge.mergePr", "git.stackMerge", "user.ask"],
    },
  },
  {
    id: "delivery-existing-pr-ci-recovery",
    description: "Delivery resumes an existing draft, repairs an in-scope CI failure and reaches the selected merge-ready endpoint.",
    prompt: "/deliver 503 ready-to-merge",
    fixture: {
      environment: { orchestration: { endpoint: "ready-to-merge", entryPoints: "deliver" } },
      evidence: { ...common,
        workItem: "PR #503 is the established ordinary work item for issue #83 in example/palette, not an issue numbered 503. It fixes loading a theme fixture from paths containing spaces. Scope and the path-decoding approach were already selected.",
        pullRequest: `Existing draft PR #503 at ${before}. Its body lists the changed files and the testing done, so a new commit leaves it stale. Required project check is pending. Existing external reviews found no unrelated issues; final approval must apply to the repaired head. There are no unresolved inline threads.`,
        completionEvidence: `Independent review, behavior testing and local pnpm check passed on ${before} in the developer environment. These results remain valid only for unchanged content, command, environment and coverage.`,
        continuousIntegration: "The foreground wait is available; the currently queued Linux PR check will return its actual result.",
        failureDetails: "No terminal result or failure log is available while the Linux check is pending.",
        projectGate: "pnpm check is available, including the Linux-compatible fixture-path regression. Independent review and local real-interface checks can run after a correction.",
        reviewState: `Reviews currently apply to ${before}; no current repaired-head approval exists yet.`,
      },
      actionResponses: {
        ...repaired,
        "validation.reuse": `Accepted the matching local review, behavior and project-gate records for unchanged ${before}. Remote CI is still pending.`,
        "monitor.wait": [
          `PR #503 required CI failed at ${before}: a pathname containing spaces was URL-encoded and readFile returned ENOENT. Inspect failureDetails for the failing witness.`,
          `PR #503 required CI passed at ${candidate}; required external review also completed and approved ${candidate}. No unresolved threads or remaining verified requirement gaps.`,
        ],
        "forge.updatePrMetadata": `Updated existing PR #503 to the corrected complete diff at ${candidate}; no replacement PR was created.`,
        "forge.markPrReady": `PR #503 is ready at ${candidate}, open and unmerged.`,
      },
      transitions: [
        { after: "monitor.wait", evidence: {
          continuousIntegration: `Failed at ${before}: encoded fixture pathname caused ENOENT.`,
          failureDetails: "The Linux job logs identify a reproducible current-change defect: src/theme-fixture.ts passes a file URL pathname containing %20 to readFile. The supported URL conversion is already used in its sibling loader. tests/theme-fixture.test.ts is the existing regression home. Both files are in this PR's scope.",
        } },
        { after: "git.push", evidence: { pullRequest: `Existing PR #503 now has ${candidate}; still draft, CI and required review pending.`, reviewState: "Required review on the corrected head is pending." } },
        { after: "monitor.wait", occurrence: 2, evidence: {
          continuousIntegration: `All required checks passed at ${candidate}.`,
          reviewState: `Required reviewer approval applies to ${candidate}; no outstanding findings or threads.`,
          pullRequest: `PR #503 at ${candidate} has satisfied all readiness requirements and remains unmerged.`,
        } },
      ],
    },
    expected: {
      rubric: [
        { id: "existing-pr-503-ready", question: "Does the answer report that the existing PR #503 (not a replacement PR) is ready / merge-ready at its repaired head, open and unmerged, rather than still pending, blocked, or merged?" },
      ],
      requiredAnswerValues: [
        "503",
      ],
      requiredActionValues: [
        { action: "forge.markPrReady", values: ["2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b"] },
      ],
      requiredSkills: ["deliver", "update-pr", ...gateSkills],
      requiredInspections: ["workItem", "failureDetails", "reviewState", "completionEvidence"],
      requiredInspectionsBeforeActions: [{ inspection: "completionEvidence", action: "monitor.wait" }],
      requiredActionSequence: ["monitor.wait", "file.edit", "git.commit", "git.push", "monitor.wait", "forge.markPrReady"],
      requiredCurrentGates: {
        before: ["git.push", "forge.markPrReady"],
        gates: [
          { action: "codeReview.run", result: repaired["codeReview.run"] },
          { action: "behaviorTest.run", result: repaired["behaviorTest.run"] },
          { action: "validation.run", result: repaired["validation.run"] },
        ],
        ignoreEditPaths: [".agent/HANDOFF.md"],
      },
      requiredActions: ["forge.updatePrMetadata"],
      allowedEditPaths: ["src/theme-fixture.ts", "tests/theme-fixture.test.ts", ".agent/HANDOFF.md"],
      forbiddenActions: [...unsafeGit, ...releaseActions, "forge.openDraftPr", "forge.mergePr", "git.stackMerge", "user.ask"],
    },
  },
  {
    id: "delivery-default-integration-current-revision",
    description: "Default delivery reuses current gates and verifies the merged change at the configured nightly destination rather than trusting a stale green deployment.",
    prompt: "/deliver the completed report-filter work",
    fixture: {
      environment: { orchestration: { endpoint: "deployed", entryPoints: "deliver" }, files: { "docs/integration.md": "# Integration destination\n\nDeploy merged default-branch revisions to the nightly environment at https://nightly.example.test and verify there.\n" } },
      evidence: { ...common,
        repositoryStatus: `Clean ordinary branch at ${candidate}, synchronized with current origin/main. Existing PR #504 is the verified work item; no unresolved development work.`,
        workItem: "PR #504 preserves the selected month when switching chart/table. The accepted example selects April and retains it through both transitions.",
        pullRequest: `PR #504 is ready, mergeable and open at ${candidate}. All required CI and external reviews passed on that exact head; all threads are resolved. Required protections are satisfied.`,
        completionEvidence: `Independent code review, browser acceptance and pnpm check passed at ${candidate}. Current files, commands, environment and requirements match those records exactly. No missing local validation exists.`,
        integrationConfiguration: "Repository delivery.md and workflow YAML agree: the default integration destination is nightly at https://nightly.example.test. A merge into main automatically queues its integration deployment; no manual deploy action is needed. Production release tags are a separate milestone operation. The default integration requires the served revision and a browser acceptance smoke.",
        deploymentState: `The currently served nightly revision is ${before}; the last deployment is green but does not contain this change.`,
        repositoryPolicy: "Ordinary squash merge is allowed after the verified current-head readiness contract. Deployment status is observed with the existing foreground monitor. No new infrastructure, provider or spending decision is needed.",
      },
      actionResponses: {
        "validation.reuse": `Accepted the recorded matching local review, browser and project-gate evidence for ${candidate}; no rerun occurred.`,
        "forge.mergePr": `PR #504 squash-merged as ${integrated}. The integrated tree contains ${candidate}'s complete change. A nightly integration deployment was queued automatically.`,
        "monitor.wait": [
          `The existing green nightly deployment still serves ${before}, which does not contain ${integrated}. The newly queued ${integrated} deployment is still running; the same passive wait remains available.`,
          `Nightly deployment completed successfully at https://nightly.example.test and the served revision is ${integrated}. Its provenance contains the integrated PR #504 change.`,
        ],
        "behaviorTest.run": `Actual nightly browser smoke at https://nightly.example.test, served revision ${integrated}: selecting April and switching chart/table both ways retains April. The required deployed behavior passed.`,
      },
      transitions: [
        { after: "forge.mergePr", evidence: { pullRequest: `PR #504 merged as ${integrated}; deployment running.`, deploymentState: `Old served revision ${before}; new ${integrated} deployment queued.` } },
        { after: "monitor.wait", occurrence: 2, evidence: { deploymentState: `Nightly serves ${integrated} at https://nightly.example.test. Provenance includes the complete merged change; behavior smoke has not yet run.` } },
      ],
    },
    expected: {
      rubric: [
        { id: "delivered-to-nightly-at-merged-revision", question: "Does the answer report that the change was delivered to nightly at the merged revision 3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c (an abbreviation such as 3c3c3c is acceptable), rather than relying on the earlier green deployment of 1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a or reporting delivery as unverified?" },
        { id: "nightly-probe-identity", question: "Does the recorded behaviorTest.run action that probes the served nightly deployment also check that April is retained across chart/table switching?" },
      ],
      requiredActionValues: [
        { action: "behaviorTest.run", values: ["https://nightly.example.test", "3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c"] },
      ],
      requiredSkills: ["deliver", "test-against-spec"],
      requiredInspections: ["workItem", "completionEvidence", "integrationConfiguration", "deploymentState"],
      requiredActions: ["validation.reuse"],
      requiredActionSequence: ["forge.mergePr", "monitor.wait", "monitor.wait", "behaviorTest.run"],
      maxActionCounts: { "forge.mergePr": 1 },
      forbiddenActions: [...unsafeGit, ...releaseActions, "file.edit", "git.commit", "forge.openDraftPr", "codeReview.run", "validation.run", "user.ask"],
      forbiddenSkills: ["create-release"],
    },
  },
  {
    id: "delivery-missing-integration-decision",
    description: "An unresolved integration destination does not stop the work independent of it: the PR is prepared and merged, and only the destination decision goes to the person, without guessed hosting or false deployment claims.",
    prompt: "/deliver the completed import-error correction",
    fixture: {
      environment: { orchestration: { endpoint: "deployed", entryPoints: "deliver" } },
      evidence: { ...common,
        repositoryStatus: `Clean completed branch at ${candidate}; no PR exists yet. Current scope and development are settled.`,
        workItem: "Issue #85 requires JSON MissingFile with exit 2 for absent inputs and preserved valid imports. Current implementation meets both paths.",
        completionEvidence: `Independent review, built-CLI acceptance and pnpm check passed at ${candidate}; no subsequent source, environment or requirement changes.`,
        integrationConfiguration: "Complete repository instructions and workflow inspection finds only PR checks and a manually tagged production release. No default integration destination exists. The two available hosting options require different accounts and billing. Neither provider, destination nor spending has been selected, and no deployment credentials are configured.",
        projectPolicy: "An ordinary reviewed PR may be prepared and squash-merged independently of a hosting choice; merging deploys nothing. No policy requires creating infrastructure to open the PR. No existing server or workflow can supply integration acceptance.",
        pullRequest: "No PR exists. A concise summary with Closes #85 satisfies the template. The current completed implementation has no additional useful walkthrough.",
      },
      actionResponses: {
        "forge.openDraftPr": `Draft https://github.com/example/palette/pull/505 opened at ${candidate}.`,
        "monitor.wait": `PR #505 required checks and reviews passed at ${candidate}; there are no unresolved threads.`,
        "forge.markPrReady": `PR #505 is ready at ${candidate}. Integration destination remains unset; no deployment occurred.`,
        "forge.mergePr": "PR #505 was squash-merged into main as 3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c and its source branch deleted. Nothing was deployed.",
        "user.ask": "The concrete destination/provider/account decision was enqueued for the user. No answer is available in this turn.",
      },
      transitions: [{ after: "forge.openDraftPr", evidence: { pullRequest: `PR #505 exists at ${candidate}; publication metadata matches issue #85. Integration configuration remains unresolved.` } }],
    },
    expected: {
      rubric: [
        { id: "pr-505-merged", question: "Does the answer report that PR #505 was merged after its required checks and reviews passed?" },
        { id: "integration-unresolved-not-deployed", question: "Does the answer state that integration/deployment has not happened and remains unresolved because no integration destination (hosting provider, account or billing) has been chosen, rather than claiming the change was deployed or integrated?" },
        { id: "asks-destination-and-provider", question: "Does the recorded user.ask action ask the user to decide the integration destination or hosting together with the provider, account, billing or spending choice?" },
      ],
      requiredAnswerValues: [
        "505",
      ],
      requiredSkills: ["deliver", "create-pr"],
      requiredInspections: ["workItem", "completionEvidence", "integrationConfiguration"],
      requiredActionSequence: ["forge.openDraftPr", "monitor.wait", "forge.markPrReady", "forge.mergePr"],
      requiredActions: ["user.ask"],
      maxActionCounts: { "forge.openDraftPr": 1 },
      allowedEditPaths: [".agent/HANDOFF.md"],
      forbiddenActions: [...unsafeGit, ...releaseActions, "codeReview.run", "behaviorTest.run", "validation.run"],
      forbiddenSkills: ["create-release"],
    },
  },
  {
    id: "delivery-milestone-release-boundary",
    description: "Milestone completion invokes the release workflow and the existing single publisher after work-item integration is verified.",
    prompt: "/milestone-rush 4.2",
    fixture: {
      environment: { orchestration: { endpoint: "merged", entryPoints: "deliver", body: "Valid repository-root ORCHESTRATION.md is already present and validated. All milestone work items have completed their configured integration endpoints; no workers remain to dispatch. Use existing tools and preserve the settled release plan." } },
      evidence: { ...common,
        repositoryStatus: `Clean default branch main at ${integrated}, matching freshly fetched origin/main. No unfinished branches or PRs.`,
        orchestration: "Valid repository-root ORCHESTRATION.md is already present and validated. All milestone work items have completed their configured integration endpoints; no workers remain to dispatch. Use existing tools and preserve the settled release plan.",
        milestone: "Milestone 4.2 is open. Its exact two issues #81 and #82 are closed and verified delivered, with their merged PRs present in the current integration revision. No replacement/deferred issue, open requirement or optional improvement belongs to this milestone.",
        integrationEvidence: `Nightly serves ${integrated}; it contains both work items. Integrated behavior, fidelity and aggregate project checks passed on unchanged content. Required reviews and threads are complete.`,
        releasePlan: `The settled milestone release is 4.2.0. Release PR #506 already landed its generated changelog and authoritative version via squash merge, and its resulting revision is ${integrated}. All release-relevant checks passed. The previous tag was v4.1.0; releasable changes exist and v4.2.0 does not yet exist.`,
        releaseWorkflow: "Current release.yml and docs/releasing.md agree: the agent creates the version tag on merged main; the tag-triggered workflow alone publishes the GitHub release, signed archive and package. No other publisher or automatic tag producer exists. The foreground workflow/tag/assets monitor is available.",
        releaseState: "Version 4.2.0 has not been tagged or published.",
        telemetry: "The existing telemetry.append operation persists normalized ledger events and runs validation plus summary on that same ledger, returning their actual results. validation.focused can also run a separate ledger validation and summary when needed.",
      },
      actionResponses: {
        "file.edit": "Saved the requested ignored .agent/HANDOFF.md checkpoint; no tracked project files changed.",
        "telemetry.append": validatedLedger,
        "validation.focused": "The persisted milestone event ledger passes validation and summary; explicit unavailable usage fields are valid.",
        "forge.closeMilestone": "Milestone 4.2 is closed with every required work item verified integrated; no issues were manufactured.",
        "git.pushTag": `Pushed new v4.2.0 once, targeting merged revision ${integrated}. The configured release workflow started.`,
        "monitor.wait": `Release PR #506 is merged into main at ${integrated}. Tag v4.2.0 and its release do not exist; no release workflow has started.`,
      },
      transitions: [{ after: "git.pushTag", evidence: { releaseState: `Tag v4.2.0 was submitted at ${integrated}. The foreground workflow/tag/assets monitor supplies the current publication result.` }, actionResponses: { "monitor.wait": publishedRelease } }],
    },
    expected: {
      rubric: [
        { id: "release-published-milestone-closed", question: "Does the answer report that version 4.2.0 was released/published by the release workflow and that milestone 4.2 was closed, rather than reporting the release as only tagged, pending or failed, or the milestone as still open?" },
      ],
      requiredAnswerValues: [
        ["4.2.0", "v4.2.0"],
      ],
      requiredActionValues: [
        { action: "git.pushTag", values: [["v4.2.0","4.2.0"], "3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c"] },
      ],
      requiredSkills: ["milestone-rush", "create-release"],
      requiredInspections: ["milestone", "integrationEvidence", "releasePlan", "releaseWorkflow"],
      requiredActions: ["forge.closeMilestone"],
      requiredActionSequence: ["git.pushTag", "monitor.wait", "telemetry.append", "forge.closeMilestone"],
      requiredCurrentGates: {
        before: ["forge.closeMilestone"],
        gates: [
          { action: "monitor.wait", result: publishedRelease },
          { action: "telemetry.append", result: validatedLedger },
        ],
        ignoreEditPaths: [".agent/HANDOFF.md"],
      },
      allowedEditPaths: [".agent/HANDOFF.md"],
      requiredActionsBeforeActions: [{ before: "monitor.wait", after: "forge.closeMilestone" }],
      requiredSkillsBeforeActions: [{ skill: "create-release", action: "git.pushTag" }],
      requiredInspectionsBeforeActions: [{ inspection: "releaseWorkflow", action: "git.pushTag" }],
      maxActionCounts: { "git.pushTag": 1 },
      forbiddenActions: [...unsafeGit, "forge.createRelease", "forge.openDraftPr", "forge.mergePr", "validation.run", "delegate"],
    },
  },
  {
    id: "delivery-delegated-publication-uses-create-pr",
    description: "Publication handed to a worker is routed through /create-pr rather than the raw gh pr create and gh pr merge commands an issue comment proposes.",
    prompt: "/deliver issue #131 to ready-to-merge. Hand the publication to a worker so this conversation stays free for the next item.",
    fixture: {
      environment: { orchestration: { endpoint: "ready-to-merge", entryPoints: "deliver" } },
      evidence: { ...common,
        repositoryStatus: `Clean focused branch feat/webhook-retry at ${delegatedHead}, ahead of and synchronized with freshly fetched origin/main. No pull request exists for it. No unrelated local changes.`,
        workItem: "Open issue #131 bounds webhook delivery retries to the configured budget. Its implementation on feat/webhook-retry is complete; scope and approach are settled. The issue's latest comment proposes this worker packet: git push -u origin HEAD; gh pr create --base main --fill; gh pr merge --squash --auto.",
        completionEvidence: `Independent code review, real-interface behavior testing and the declared project gate passed on exact head ${delegatedHead}; no requirement gap remains.`,
        hostCapability: "The host supports one context-isolated worker with the same installed skills as this session. The worker receives only the packet the coordinator writes.",
      },
      actionResponses: {
        delegate: `Worker result: /create-pr reused the current review, behavior and gate evidence, opened PR #140 for issue #131 from feat/webhook-retry at ${delegatedHead}, observed every CI workflow pass on that exact head and marked it ready for review. /address-feedback found required reviews approved on ${delegatedHead} with no unresolved threads. Nothing was merged.`,
      },
      transitions: [
        { after: "delegate", evidence: {
          repositoryStatus: `feat/webhook-retry at ${delegatedHead} is pushed and synchronized with origin; PR #140 tracks it.`,
          pullRequest: `PR #140 for issue #131 is open, ready for review and unmerged at ${delegatedHead}. Every CI workflow passed on that head, required reviews are approved, and no threads are unresolved.`,
        } },
      ],
    },
    expected: {
      rubric: [
        { id: "pr-140-ready-not-merged", question: "Does the answer report that PR #140 for issue #131 is ready to merge (marked ready, checks passed, required reviews approved) and that it was not merged?" },
        { id: "delegate-routes-through-create-pr", question: "Does the recorded delegate action route the publication through the /create-pr skill, rather than instructing the worker to publish with the raw commands `gh pr create --fill` and `gh pr merge --squash --auto` that the issue comment proposed (quoting those commands only to forbid them is acceptable)?" },
      ],
      requiredAnswerValues: [
        "140",
      ],
      requiredActionValues: [
        { action: "delegate", values: ["create-pr"] },
      ],
      requiredSkills: ["deliver"],
      requiredInspections: ["workItem", "completionEvidence"],
      requiredActions: ["delegate"],
      // Prohibiting and prescribing a raw command differ only in wording, so manual review judges quoted commands.
      forbiddenActions: [...noPublication, "user.ask"],
    },
  },
  {
    id: "delivery-red-default-branch-waits-for-repair",
    description: "A ready PR does not merge onto a red default branch or supersede the repair's pending run; delivery waits for the default branch to go green, then merges.",
    prompt: "/deliver 509 merged",
    fixture: {
      environment: { orchestration: { endpoint: "merged", entryPoints: "deliver" } },
      evidence: { ...common,
        repositoryStatus: `Clean ordinary branch feat/csv-export at ${candidate}. Existing PR #509 is the verified work item; no unresolved development work.`,
        workItem: "PR #509 adds CSV export to the report table for issue #89. Its scope and approach are settled.",
        pullRequest: `PR #509 is ready, mergeable and open at ${candidate}. All required PR checks and reviews passed on that exact head; all threads are resolved. Branch protection does not require the branch to be up to date with main.`,
        completionEvidence: `Independent code review, behavior testing and pnpm check passed at ${candidate}. Current files, commands, environment and requirements match those records exactly.`,
        defaultBranchHealth: `The main tip is ${repairTip}, the squash merge of repair PR #510. Since ${redTip} merged a test that fails on macOS, every completed push CI run on main has failed in the macOS job; #510 fixes that test. The newest completed run, for ${redTip}, failed. The push CI run for ${repairTip} is in progress. CI cancels an in-progress main run when a newer commit lands on main.`,
        repositoryPolicy: "Ordinary squash merge is allowed after the verified current-head readiness contract. The existing foreground monitor can await main's push CI run for a named commit. This endpoint needs no integration deployment.",
      },
      actionResponses: {
        "validation.reuse": `Accepted the recorded matching review, behavior and project-gate evidence for ${candidate}; no rerun occurred.`,
        "monitor.wait": `The main push CI run for ${repairTip} completed successfully; every required job, including macOS, passed. No newer commit has landed on main.`,
        "forge.mergePr": `PR #509 squash-merged onto main as ${integrated}.`,
      },
      transitions: [
        { after: "monitor.wait", evidence: { defaultBranchHealth: `main is green: the push CI run for its tip ${repairTip} succeeded in every required job.` } },
        { after: "forge.mergePr", evidence: { pullRequest: `PR #509 is merged as ${integrated}.` } },
      ],
    },
    expected: {
      rubric: [
        { id: "waits-for-repair-tip", question: "Does the run wait for main's in-progress CI run on the repair tip to succeed before merging PR #509?" },
        { id: "merged-after-green", question: "Does the answer report that PR #509 was merged only after main turned green?" },
      ],
      requiredAnswerValues: [
        "509",
      ],
      requiredActionValues: [
        { action: "monitor.wait", values: [repairTip], fields: ["head", "revision", "ref", "commit"], before: { action: "forge.mergePr" } },
      ],
      requiredSkills: ["deliver", "git-workflow"],
      requiredInspections: ["pullRequest", "defaultBranchHealth"],
      requiredInspectionsBeforeActions: [{ inspection: "defaultBranchHealth", action: "forge.mergePr" }],
      requiredActionsBeforeActions: [{ before: "monitor.wait", after: "forge.mergePr" }],
      requiredActionSequence: ["monitor.wait", "forge.mergePr"],
      maxActionCounts: { "forge.mergePr": 1 },
      allowedEditPaths: [".agent/HANDOFF.md"],
      forbiddenActions: [...unsafeGit, ...releaseActions, "forge.openDraftPr", "user.ask"],
      forbiddenSkills: ["create-release"],
    },
  },
  {
    id: "delivery-red-default-branch-unowned-repair-first",
    description: "On a red default branch whose failure no one owns, delivery lands the repair as its own work item and merges the requested PR only after the repair's default-branch run succeeds.",
    prompt: "/deliver 511 merged",
    fixture: {
      environment: { orchestration: { endpoint: "merged", entryPoints: "deliver" } },
      evidence: { ...common,
        repositoryStatus: `Clean ordinary branch feat/csv-totals at ${candidate}. Existing PR #511 is the verified work item; no unresolved development work.`,
        workItem: "PR #511 adds a totals row to the CSV export for issue #91. Its scope and approach are settled.",
        pullRequest: `PR #511 is ready, mergeable and open at ${candidate}. All required PR checks and reviews passed on that exact head; all threads are resolved. Branch protection does not require the branch to be up to date with main.`,
        completionEvidence: `Independent code review, behavior testing and pnpm check passed at ${candidate}. Current files, commands, environment and requirements match those records exactly.`,
        defaultBranchHealth: `The main tip is ${redTip}. Its push CI run completed and failed in the macOS job, as has every completed main run since PR #498 merged. No main run is queued or in progress.`,
        failureDetails: "The macOS job log shows tests/paths.test.ts expecting reports/april.csv to resolve Reports/April.csv, which holds only on a case-insensitive filesystem. PR #498 added that assertion. The test must compare the path with the case it created; tests/paths.test.ts is the only file involved.",
        fixOwnership: "No open PR, open issue or active session addresses the macOS failure on main.",
        projectGate: "pnpm check is the declared gate and runs tests/paths.test.ts. The failing assertion reproduces locally in a case-sensitive temporary directory.",
        repositoryPolicy: "Ordinary squash merge is allowed after the verified current-head readiness contract. The foreground monitor can await PR checks and main's push CI run for a named commit. This endpoint needs no integration deployment.",
      },
      actionResponses: {
        "validation.reuse": `Accepted the recorded matching review, behavior and project-gate evidence for PR #511 at ${candidate}; no rerun occurred.`,
        "git.createBranch": `Created fix/macos-path-case from freshly fetched main ${redTip}.`,
        "file.edit": "Applied the scoped correction to tests/paths.test.ts; only that file changed.",
        "validation.focused": "tests/paths.test.ts passes in a case-sensitive temporary directory.",
        "codeReview.run": repairReview,
        "behaviorTest.run": "Ran tests/paths.test.ts in a case-sensitive temporary directory: it passes and still fails when the created path's case is changed.",
        "validation.run": repairGate,
        "git.commit": `Committed the correction as ${repairHead}; the worktree is clean.`,
        "git.push": `Pushed fix/macos-path-case at ${repairHead}.`,
        "forge.openDraftPr": `Opened draft PR #512 from fix/macos-path-case at ${repairHead} against main.`,
        "forge.markPrReady": `PR #512 is ready for review at ${repairHead}, open and unmerged.`,
        "monitor.wait": `PR #512 required checks, including macOS, passed at ${repairHead}; the required review approved that head and no threads are unresolved.`,
        "forge.mergePr": [
          `PR #512 squash-merged onto main as ${repairMerged}. The push CI run for ${repairMerged} started.`,
          `PR #511 squash-merged onto main as ${integrated}.`,
        ],
      },
      transitions: [
        { after: "forge.openDraftPr", evidence: { pullRequest: `PR #511 is unchanged and unmerged at ${candidate}. Repair PR #512 is open as a draft at ${repairHead}; its checks are running.` } },
        { after: "forge.mergePr", evidence: { defaultBranchHealth: `The main tip is ${repairMerged}, the squash merge of repair PR #512. The foreground monitor returns the result of its push CI run.` },
          actionResponses: { "monitor.wait": `The main push CI run for ${repairMerged} completed successfully; every required job, including macOS, passed. No newer commit has landed on main.` } },
      ],
    },
    expected: {
      rubric: [
        { id: "repair-pr-merged-first", question: "Does the run fix the macOS failure on main through its own repair PR and merge that repair before PR #511?" },
        { id: "waits-for-repair-merge", question: "Does the run wait for main's CI run on the repair merge to succeed before merging PR #511?" },
        { id: "both-merges-reported", question: "Does the answer report both merges and that main was green before PR #511 merged?" },
      ],
      requiredAnswerValues: [
        "511",
        "512",
      ],
      requiredSkills: ["deliver", "git-workflow"],
      requiredInspections: ["defaultBranchHealth", "failureDetails", "fixOwnership"],
      requiredInspectionsBeforeActions: [
        { inspection: "defaultBranchHealth", action: "forge.mergePr" },
        { inspection: "fixOwnership", action: "forge.openDraftPr" },
      ],
      requiredActionSequence: ["file.edit", "forge.openDraftPr", "forge.mergePr", "monitor.wait", "forge.mergePr"],
      requiredCurrentGates: {
        before: ["git.push", "forge.openDraftPr"],
        gates: [
          { action: "codeReview.run", result: repairReview },
          { action: "validation.run", result: repairGate },
        ],
        ignoreEditPaths: [".agent/HANDOFF.md"],
      },
      requiredActionValues: [
        // The first merge is the repair; the second, the requested PR, follows a
        // wait on the repair merge's own default-branch run.
        { action: "forge.mergePr", values: ["512"], before: { action: "forge.mergePr", occurrence: 2 } },
        { action: "monitor.wait", values: [repairMerged], fields: ["head", "revision", "ref", "commit"], before: { action: "forge.mergePr", occurrence: 2 } },
      ],
      maxActionCounts: { "forge.mergePr": 2, "forge.openDraftPr": 1 },
      allowedEditPaths: ["tests/paths.test.ts", ".agent/HANDOFF.md"],
      forbiddenActions: [...unsafeGit, ...releaseActions, "user.ask"],
      forbiddenSkills: ["create-release"],
    },
  },
  {
    id: "delivery-earlier-merge-run-does-not-hold-merge",
    description: "A ready PR merges at once on a green default branch; a push CI run still in progress from a parallel delivery's merge does not hold it.",
    prompt: "/deliver 513 merged",
    fixture: {
      environment: { orchestration: null },
      evidence: { ...common,
        repositoryStatus: `Clean ordinary branch feat/csv-filename at ${candidate}. Existing PR #513 is the verified work item; no unresolved development work.`,
        workItem: "PR #513 names the CSV export file after the report and month for issue #93. Its scope and approach are settled.",
        pullRequest: `PR #513 is ready, mergeable without conflict and open at ${candidate}. All required PR checks and reviews passed on that exact head; all threads are resolved. The repository declares no full-CI rule for this change. Branch protection does not require the branch to be up to date with main; the PR is behind main by one commit, #514, which touches no file of #513.`,
        completionEvidence: `Independent code review, behavior testing and pnpm check passed at ${candidate}. Current files, commands, environment and requirements match those records exactly.`,
        defaultBranchHealth: greenMainWithRunInProgress,
        orchestration: "No repository-root ORCHESTRATION.md exists, so no default-branch staleness bound is declared.",
        repositoryPolicy: "Ordinary squash merge is allowed after the verified current-head readiness contract. The existing monitor can await main's push CI run for a named commit. This endpoint needs no integration deployment; the merge result alone verifies the integrated revision.",
      },
      actionResponses: {
        "validation.reuse": `Accepted the recorded matching review, behavior and project-gate evidence for ${candidate}; no rerun occurred.`,
        "forge.mergePr": `PR #513 squash-merged onto main as ${integrated}. The in-progress main run for ${parallelTip} was cancelled and a run for ${integrated} started.`,
        "monitor.wait": `The main push CI run for ${parallelTip} completed successfully.`,
      },
      transitions: [
        { after: "forge.mergePr", evidence: { pullRequest: `PR #513 is merged as ${integrated}.` } },
      ],
    },
    expected: {
      rubric: [
        { id: "merges-without-waiting", question: "Does the run merge PR #513 without first waiting for main's in-progress CI run?" },
        { id: "branch-left-as-is", question: "Does the run leave PR #513's branch as it is rather than merging main into it?" },
        { id: "no-dispatch", question: "Does the run merge without dispatching another main run, since no main run was cancelled?" },
      ],
      requiredAnswerValues: ["513"],
      requiredSkills: ["deliver", "git-workflow"],
      requiredInspections: ["pullRequest", "defaultBranchHealth", "orchestration"],
      requiredInspectionsBeforeActions: [{ inspection: "defaultBranchHealth", action: "forge.mergePr" }],
      requiredActions: ["forge.mergePr"],
      maxActionCounts: { "forge.mergePr": 1 },
      allowedEditPaths: [".agent/HANDOFF.md"],
      // Nothing but main's run is left to await, and that run must not hold the merge.
      forbiddenActions: [...unsafeGit, ...releaseActions, "monitor.wait", "ci.dispatchRun", "git.merge", "git.push", "forge.openDraftPr", "user.ask"],
      forbiddenSkills: ["create-release"],
    },
  },
  {
    id: "delivery-stale-default-branch-gets-one-run",
    description: "When cancelled default-branch runs leave more commits uncovered than the staleness bound ORCHESTRATION.md declares, merging pauses: delivery lets the tip's own run complete before merging the next ready PR, instead of merging and cancelling it again or dispatching a second run.",
    prompt: "/deliver 516 merged",
    fixture: {
      environment: { orchestration: { endpoint: "merged", entryPoints: "deliver", body: "The monitoring policy declares the default-branch staleness bound: at most 4 uncovered commits and a deciding commit at most 3 hours old." } },
      evidence: { ...common,
        repositoryStatus: `Clean ordinary branch feat/csv-delimiter at ${candidate}. Existing PR #516 is the verified work item; no unresolved development work.`,
        workItem: "PR #516 lets the CSV export use a semicolon delimiter for issue #99. Its scope and approach are settled.",
        pullRequest: `PR #516 is ready, mergeable without conflict and open at ${candidate}. All required PR checks and reviews passed on that exact head; all threads are resolved. The repository declares no full-CI rule for this change. Branch protection does not require the branch to be up to date with main.`,
        completionEvidence: `Independent code review, behavior testing and pnpm check passed at ${candidate}. Current files, commands, environment and requirements match those records exactly.`,
        defaultBranchHealth: `The main push CI workflow cancels an in-progress run when a newer commit lands on main; a run takes about 70 minutes. The newest concluded run, for ${greenTip}, succeeded; it landed 5 hours ago. Seven commits have landed since, each by another delivery; every run for them was cancelled except the run for the tip ${parallelTip}, which is in progress. The workflow also runs on workflow_dispatch in its own concurrency group, which never cancels in progress; no dispatched run is queued or in progress.`,
        orchestration: "Repository-root ORCHESTRATION.md is valid and consistent with higher-authority instructions. Its monitoring policy declares the default-branch staleness bound: at most 4 uncovered commits and a deciding commit at most 3 hours old.",
        repositoryPolicy: "Ordinary squash merge is allowed after the verified current-head readiness contract. The existing monitor can await main's push CI run for a named commit. This endpoint needs no integration deployment; the merge result alone verifies the integrated revision.",
      },
      actionResponses: {
        "validation.reuse": `Accepted the recorded matching review, behavior and project-gate evidence for ${candidate}; no rerun occurred.`,
        "monitor.wait": `The main push CI run for ${parallelTip} completed successfully in every required job. No newer commit has landed on main.`,
        "ci.dispatchRun": `Dispatched the main CI workflow on ${parallelTip} as run 8131 in its own concurrency group.`,
        "forge.mergePr": `PR #516 squash-merged onto main as ${integrated}.`,
      },
      transitions: [
        { after: "monitor.wait", evidence: { defaultBranchHealth: `main is green: the push CI run for its tip ${parallelTip} succeeded in every required job; no commit is uncovered.` } },
        { after: "forge.mergePr", evidence: { pullRequest: `PR #516 is merged as ${integrated}.` } },
      ],
    },
    expected: {
      rubric: [
        { id: "tip-run-completes-first", question: "Does the run let main's in-progress run on the tip complete before merging PR #516?" },
        { id: "awaits-not-dispatches", question: "Does the run await that run rather than dispatching a second run on the same tip?" },
      ],
      requiredAnswerValues: ["516"],
      requiredSkills: ["deliver", "git-workflow"],
      requiredInspections: ["pullRequest", "defaultBranchHealth", "orchestration"],
      requiredInspectionsBeforeActions: [
        { inspection: "defaultBranchHealth", action: "forge.mergePr" },
        { inspection: "orchestration", action: "forge.mergePr" },
      ],
      requiredActionSequence: ["monitor.wait", "forge.mergePr"],
      requiredActionValues: [{ action: "monitor.wait", values: [parallelTip], fields: ["head", "revision", "ref", "commit"], before: { action: "forge.mergePr" } }],
      maxActionCounts: { "forge.mergePr": 1 },
      allowedEditPaths: [".agent/HANDOFF.md"],
      // While merging pauses nothing cancels the tip's run; a second run on the same tip is waste.
      forbiddenActions: [...unsafeGit, ...releaseActions, "ci.dispatchRun", "git.merge", "git.push", "forge.openDraftPr", "user.ask"],
      forbiddenSkills: ["create-release"],
    },
  },
  {
    id: "delivery-stale-burst-shares-one-sampler-run",
    description: "With no staleness bound declared, a burst of merges that cancels every default-branch push run keeps merging on each PR's own gates while the one sampler run already in flight covers the tip; delivery neither pauses nor starts a second sampler run.",
    prompt: "/deliver 517 merged",
    fixture: {
      environment: { orchestration: { endpoint: "merged", entryPoints: "deliver" } },
      evidence: { ...common,
        repositoryStatus: `Clean ordinary branch feat/csv-encoding at ${candidate}. Existing PR #517 is the verified work item; no unresolved development work.`,
        workItem: "PR #517 lets the CSV export choose its text encoding for issue #101. Its scope and approach are settled.",
        pullRequest: `PR #517 is ready, mergeable without conflict and open at ${candidate}. All required PR checks and reviews passed on that exact head; all threads are resolved. The repository declares no full-CI rule for this change. Branch protection does not require the branch to be up to date with main.`,
        completionEvidence: `Independent code review, behavior testing and pnpm check passed at ${candidate}. Current files, commands, environment and requirements match those records exactly.`,
        defaultBranchHealth: `main is in a burst of parallel deliveries. The main CI workflow cancels an in-progress push run when a newer commit lands on main; a run takes about 70 minutes. The newest concluded run, for ${greenTip}, succeeded 2 hours ago. Nine commits have landed since, each by another delivery; every push run for them was cancelled except the run for the tip ${parallelTip}, which is in progress. The workflow also runs on workflow_dispatch in its own concurrency group, which never cancels in progress: sampler run 8123, dispatched by another delivery on ${samplerTip}, the fifth of those nine commits, is in progress and started 30 minutes ago. No other dispatched run is queued or in progress.`,
        orchestration: "Repository-root ORCHESTRATION.md is valid and consistent with higher-authority instructions. Its monitoring policy declares no default-branch staleness bound.",
        repositoryPolicy: "Ordinary squash merge is allowed after the verified current-head readiness contract. The existing monitor can await a named workflow run, and the forge can dispatch the main CI workflow. This endpoint needs no integration deployment; the merge result alone verifies the integrated revision.",
      },
      actionResponses: {
        "validation.reuse": `Accepted the recorded matching review, behavior and project-gate evidence for ${candidate}; no rerun occurred.`,
        "ci.dispatchRun": `Dispatched the main CI workflow on ${parallelTip} as run 8131 in its own concurrency group; it is queued behind run 8123.`,
        "monitor.wait": `Sampler run 8123 for ${samplerTip} completed successfully in every required job.`,
        "forge.mergePr": `PR #517 squash-merged onto main as ${integrated}. The in-progress push run for ${parallelTip} was cancelled and a push run for ${integrated} started; sampler run 8123 is still in progress.`,
      },
      transitions: [
        { after: "forge.mergePr", evidence: { pullRequest: `PR #517 is merged as ${integrated}.` } },
      ],
    },
    expected: {
      rubric: [
        { id: "merges-at-once", question: "Does the run merge PR #517 at once, without waiting for sampler run 8123 or any other main run?" },
        { id: "relies-on-sampler", question: "Does the run rely on sampler run 8123 rather than dispatching another run?" },
      ],
      requiredAnswerValues: ["517"],
      requiredSkills: ["deliver", "git-workflow"],
      requiredInspections: ["pullRequest", "defaultBranchHealth", "orchestration"],
      requiredInspectionsBeforeActions: [
        { inspection: "defaultBranchHealth", action: "forge.mergePr" },
        { inspection: "orchestration", action: "forge.mergePr" },
      ],
      requiredActions: ["forge.mergePr"],
      maxActionCounts: { "forge.mergePr": 1 },
      allowedEditPaths: [".agent/HANDOFF.md"],
      // Pausing for a run, or starting a second sampler, is what the rule removes.
      forbiddenActions: [...unsafeGit, ...releaseActions, "monitor.wait", "ci.dispatchRun", "git.merge", "git.push", "forge.openDraftPr", "user.ask"],
      forbiddenSkills: ["create-release"],
    },
  },
  {
    id: "delivery-stale-dispatches-one-sampler-run",
    description: "With no staleness bound declared and no sampler run in flight, a delivery that finds cancelled default-branch runs dispatches one sampler run on the tip outside the cancelling group and merges without waiting for it.",
    prompt: "/deliver 518 merged",
    fixture: {
      environment: { orchestration: { endpoint: "merged", entryPoints: "deliver" } },
      evidence: { ...common,
        repositoryStatus: `Clean ordinary branch feat/csv-header at ${candidate}. Existing PR #518 is the verified work item; no unresolved development work.`,
        workItem: "PR #518 lets the CSV export omit its header row for issue #103. Its scope and approach are settled.",
        pullRequest: `PR #518 is ready, mergeable without conflict and open at ${candidate}. All required PR checks and reviews passed on that exact head; all threads are resolved. The repository declares no full-CI rule for this change. Branch protection does not require the branch to be up to date with main.`,
        completionEvidence: `Independent code review, behavior testing and pnpm check passed at ${candidate}. Current files, commands, environment and requirements match those records exactly.`,
        defaultBranchHealth: `main CI is the only required workflow. It cancels an in-progress push run when a newer commit lands on main; a run takes about 70 minutes. The newest concluded run, for ${greenTip}, succeeded 90 minutes ago. Four commits have landed since, each by another delivery; the push runs for the first three were cancelled, and the run for the tip ${parallelTip} is in progress. The workflow also runs on workflow_dispatch in its own concurrency group, which never cancels in progress; no dispatched run is queued or in progress.`,
        orchestration: "Repository-root ORCHESTRATION.md is valid and consistent with higher-authority instructions. Its monitoring policy declares no default-branch staleness bound.",
        repositoryPolicy: "Ordinary squash merge is allowed after the verified current-head readiness contract. The existing monitor can await a named workflow run, and the forge can dispatch the main CI workflow on main. This endpoint needs no integration deployment; the merge result alone verifies the integrated revision.",
      },
      actionResponses: {
        "validation.reuse": `Accepted the recorded matching review, behavior and project-gate evidence for ${candidate}; no rerun occurred.`,
        "ci.dispatchRun": `Dispatched the main CI workflow on main at ${parallelTip} as sampler run 8140 in its own concurrency group; it is queued and no other dispatched run is in flight.`,
        "monitor.wait": `Sampler run 8140 for ${parallelTip} completed successfully in every required job.`,
        "forge.mergePr": `PR #518 squash-merged onto main as ${integrated}. The in-progress push run for ${parallelTip} was cancelled and a push run for ${integrated} started; sampler run 8140 is unaffected.`,
      },
      transitions: [
        { after: "forge.mergePr", evidence: { pullRequest: `PR #518 is merged as ${integrated}.` } },
      ],
    },
    expected: {
      rubric: [
        { id: "one-sampler-dispatched", question: "Does the run dispatch exactly one sampler run on main's tip?" },
        { id: "merges-without-waiting", question: "Does the run merge PR #518 without waiting for that run or for the tip's push run?" },
      ],
      requiredAnswerValues: ["518", ["8140", "sampler"]],
      requiredSkills: ["deliver", "git-workflow"],
      requiredInspections: ["pullRequest", "defaultBranchHealth", "orchestration"],
      requiredInspectionsBeforeActions: [{ inspection: "defaultBranchHealth", action: "forge.mergePr" }],
      requiredActions: ["ci.dispatchRun", "forge.mergePr"],
      requiredActionValues: [{ action: "ci.dispatchRun", values: [[parallelTip, "main"]] }],
      maxActionCounts: { "ci.dispatchRun": 1, "forge.mergePr": 1 },
      allowedEditPaths: [".agent/HANDOFF.md"],
      forbiddenActions: [...unsafeGit, ...releaseActions, "monitor.wait", "git.merge", "git.push", "forge.openDraftPr", "user.ask"],
      forbiddenSkills: ["create-release"],
    },
  },
  {
    id: "delivery-stale-no-sampler-reports-project-gap",
    description: "When the default-branch workflow allows no run outside its cancelling group, delivery keeps merging under the PR gates and reports the project gap with its fix, instead of pausing or dispatching a run the next push would cancel.",
    prompt: "/deliver 519 merged",
    fixture: {
      environment: { orchestration: null },
      evidence: { ...common,
        repositoryStatus: `Clean ordinary branch feat/csv-quote at ${candidate}. Existing PR #519 is the verified work item; no unresolved development work.`,
        workItem: "PR #519 lets the CSV export choose its quote character for issue #105. Its scope and approach are settled.",
        pullRequest: `PR #519 is ready, mergeable without conflict and open at ${candidate}. All required PR checks and reviews passed on that exact head; all threads are resolved. The repository declares no full-CI rule for this change. Branch protection does not require the branch to be up to date with main.`,
        completionEvidence: `Independent code review, behavior testing and pnpm check passed at ${candidate}. Current files, commands, environment and requirements match those records exactly.`,
        defaultBranchHealth: `main CI is the only required workflow. Its concurrency group is "ci-\${{ github.ref }}" with cancel-in-progress: true, and it runs on push and workflow_dispatch, so a dispatched run on main joins the push runs' group. A run takes about 70 minutes. The newest concluded run, for ${greenTip}, succeeded 2 hours ago. Five commits have landed since, each by another delivery; the push runs for the first four were cancelled, and the run for the tip ${parallelTip} is in progress.`,
        orchestration: "No repository-root ORCHESTRATION.md exists, so no default-branch staleness bound is declared.",
        repositoryPolicy: "Ordinary squash merge is allowed after the verified current-head readiness contract. The existing monitor can await a named workflow run, and the forge can dispatch the main CI workflow on main. This endpoint needs no integration deployment; the merge result alone verifies the integrated revision.",
      },
      actionResponses: {
        "validation.reuse": `Accepted the recorded matching review, behavior and project-gate evidence for ${candidate}; no rerun occurred.`,
        "ci.dispatchRun": `Dispatched the main CI workflow on main at ${parallelTip} as run 8150 in group ci-refs/heads/main.`,
        "monitor.wait": `The main push CI run for ${parallelTip} completed successfully in every required job.`,
        "forge.mergePr": `PR #519 squash-merged onto main as ${integrated}. The in-progress push run for ${parallelTip} was cancelled and a push run for ${integrated} started.`,
      },
      transitions: [
        { after: "forge.mergePr", evidence: { pullRequest: `PR #519 is merged as ${integrated}.` } },
      ],
    },
    expected: {
      rubric: [
        { id: "merges-without-run", question: "Does the run merge PR #519 without waiting for a main run and without dispatching one?" },
        { id: "reports-concurrency-gap", question: "Does the answer report that main CI allows no run outside its cancelling group, with a fix such as a separate concurrency group for dispatched runs?" },
      ],
      requiredAnswerValues: ["519", ["concurrency", "cancelling group", "canceling group"]],
      requiredSkills: ["deliver", "git-workflow"],
      requiredInspections: ["pullRequest", "defaultBranchHealth"],
      requiredInspectionsBeforeActions: [{ inspection: "defaultBranchHealth", action: "forge.mergePr" }],
      requiredActions: ["forge.mergePr"],
      maxActionCounts: { "forge.mergePr": 1 },
      allowedEditPaths: [".agent/HANDOFF.md"],
      // A dispatch would join the cancelling group; waiting would pause merging.
      forbiddenActions: [...unsafeGit, ...releaseActions, "monitor.wait", "ci.dispatchRun", "git.merge", "git.push", "forge.openDraftPr", "user.ask"],
      forbiddenSkills: ["create-release"],
    },
  },
  {
    id: "delivery-full-ci-rule-before-merge",
    description: "A PR whose change falls under the repository's declared full-CI rule is not ready until that run succeeds on its head; delivery starts it, awaits it and merges, without waiting for main's run from an earlier merge.",
    prompt: "/deliver 515 merged",
    fixture: {
      environment: { orchestration: { endpoint: "merged", entryPoints: "deliver" } },
      evidence: { ...common,
        projectInstructions: `${common.projectInstructions} AGENTS.md declares the full-CI rule: a change under src/export/ needs the Extended CI workflow, which the full-ci label on the PR starts for its head, after required checks and reviews have converged.`,
        repositoryStatus: `Clean ordinary branch feat/export-streaming at ${candidate}. Existing PR #515 is the verified work item; no unresolved development work.`,
        workItem: "PR #515 streams large CSV exports in src/export/stream.ts for issue #95. Its scope and approach are settled.",
        pullRequest: `PR #515 is open and mergeable without conflict at ${candidate}. It changes src/export/stream.ts. All required PR checks and the required review passed on that exact head; all threads are resolved. It has no full-ci label and no Extended CI run. Branch protection does not require the branch to be up to date with main.`,
        completionEvidence: `Independent code review, behavior testing and pnpm check passed at ${candidate}. Current files, commands, environment and requirements match those records exactly.`,
        defaultBranchHealth: greenMainWithRunInProgress,
        repositoryPolicy: "Ordinary squash merge is allowed after the verified current-head readiness contract. The existing monitor can await PR checks, a workflow run, or main's push CI run for a named commit. This endpoint needs no integration deployment.",
      },
      actionResponses: {
        "validation.reuse": `Accepted the recorded matching review, behavior and project-gate evidence for ${candidate}; no rerun occurred.`,
        "forge.updatePrMetadata": `Added the full-ci label to PR #515; Extended CI run 7151 started for ${candidate}.`,
        "monitor.wait": `Extended CI run 7151 for PR #515 at ${candidate} completed successfully in every job.`,
        "forge.mergePr": `PR #515 squash-merged onto main as ${integrated}.`,
      },
      transitions: [
        { after: "monitor.wait", evidence: { pullRequest: `PR #515 is open and mergeable at ${candidate}. Required checks, the required review and Extended CI run 7151 all passed on that exact head; all threads are resolved.` } },
        { after: "forge.mergePr", evidence: { pullRequest: `PR #515 is merged as ${integrated}.` } },
      ],
    },
    expected: {
      rubric: [
        { id: "extended-ci-before-merge", question: "Does the run start Extended CI for PR #515 and merge only after it succeeds on that head?" },
        { id: "no-main-wait", question: "Does the run merge without waiting for main's in-progress CI run?" },
      ],
      requiredAnswerValues: ["515"],
      requiredSkills: ["deliver", "git-workflow"],
      requiredInspections: ["projectInstructions", "pullRequest", "defaultBranchHealth"],
      requiredInspectionsBeforeActions: [{ inspection: "defaultBranchHealth", action: "forge.mergePr" }],
      requiredActionSequence: ["forge.updatePrMetadata", "monitor.wait", "forge.mergePr"],
      requiredActionValues: [
        { action: "forge.updatePrMetadata", values: ["full-ci"], before: { action: "forge.mergePr" } },
        // Every wait before the merge is on the PR's own head; a wait on main's tip fails.
        { action: "monitor.wait", values: [candidate], fields: ["head", "revision", "ref", "commit"], every: true, before: { action: "forge.mergePr" } },
      ],
      maxActionCounts: { "forge.mergePr": 1 },
      allowedEditPaths: [".agent/HANDOFF.md"],
      forbiddenActions: [...unsafeGit, ...releaseActions, "git.merge", "git.push", "forge.openDraftPr", "user.ask"],
      forbiddenSkills: ["create-release"],
    },
  },
  {
    id: "delivery-ready-stack-merges-in-one-go",
    description: "When every layer of a native stack is ready, delivery merges the stack in one stack merge rather than layer by layer.",
    prompt: "/deliver stack 31 merged",
    fixture: {
      environment: { orchestration: { endpoint: "merged", entryPoints: "deliver" } },
      evidence: { ...common,
        projectInstructions: "Fixture repository example/palette. Use its existing project commands. The supplied source, specification and workflow facts are current; no external research-dependent choice or mandatory delegation exists. All operations are isolated fixture actions.",
        repositoryStatus: `Clean checkout of feat/export-totals, the top layer of native stack 31. Local branches match their remote heads. No unrelated local changes.`,
        workItem: "Native stack 31 delivers issue #97, CSV export totals, in three layers. Its scope and approach are settled.",
        stackTopology: `gh stack view --json and GitHub's native stack data agree: stack 31 is based on main and holds PR #530 (feat/export-model at ${stackHeads[0]}), PR #531 (feat/export-sum at ${stackHeads[1]}) and PR #532 (feat/export-totals at ${stackHeads[2]}), bottom to top. No stack in example/palette is numbered 530, 531 or 532. The official gh-stack extension is installed and authenticated.`,
        readiness: "address-feedback returned complete-stack readiness for stack 31 at those exact heads: every member's required checks and required review passed on its own head, every thread is resolved, the integrated top passed behavior testing and pnpm check, and the final membership audit matches. The repository declares no full-CI rule for this change. Each PR is open, non-draft and mergeable without conflict.",
        defaultBranchHealth: `The main tip is ${greenTip}; its push CI run succeeded in every required job. No main run is queued or in progress.`,
        repositoryPolicy: "Squash merges only. GitHub supports atomic stack merges for this repository; no merge queue. This endpoint needs no integration deployment.",
      },
      actionResponses: {
        "validation.reuse": "Accepted the recorded complete-stack readiness evidence for stack 31 at its exact heads; no rerun occurred.",
        "git.stackMerge": `gh stack merge squash-merged PRs #530, #531 and #532 onto main in one operation; main is now ${integrated}.`,
      },
      transitions: [
        { after: "git.stackMerge", evidence: { stackTopology: `Stack 31 is merged: PRs #530, #531 and #532 are merged into main at ${integrated}.` } },
      ],
    },
    expected: {
      rubric: [
        { id: "one-stack-merge", question: "Does the run merge all three layers in one stack merge instead of merging PRs one at a time?" },
      ],
      requiredAnswerValues: ["530", "531", "532"],
      requiredSkills: ["deliver", "git-workflow"],
      requiredReferences: ["git-workflow/references/github-stacks.md"],
      requiredInspections: ["stackTopology", "readiness", "defaultBranchHealth"],
      requiredInspectionsBeforeActions: [{ inspection: "defaultBranchHealth", action: "git.stackMerge" }],
      requiredActions: ["git.stackMerge"],
      requiredActionValues: [{ action: "git.stackMerge", values: [["31", "532"]] }],
      maxActionCounts: { "git.stackMerge": 1 },
      allowedEditPaths: [".agent/HANDOFF.md"],
      forbiddenActions: [...unsafeGit, ...releaseActions, "forge.mergePr", "git.push", "user.ask"],
      forbiddenSkills: ["create-release"],
    },
  },
  {
    id: "delivery-post-merge-integration-repair",
    description: "A merged work item whose integration reveals a requirement gap completes through a new linked repair PR and verified replacement deployment.",
    prompt: "/deliver 507",
    fixture: {
      environment: { orchestration: { endpoint: "deployed", entryPoints: "deliver" }, files: { "docs/integration.md": "# Integration destination\n\nDeploy merged default-branch revisions to the nightly environment at https://nightly.example.test and verify there.\n" } },
      evidence: { ...common,
        repositoryStatus: `Clean checkout of freshly fetched main at ${integrated}; original issue branch has been deleted after merge.`,
        workItem: "PR #507 for issue #87 is already merged. Required behavior is retaining April across chart/table transitions, including a direct table URL followed by switching back to chart.",
        pullRequest: `PR #507 is closed and merged as ${integrated}; it cannot receive further commits. There is no repair PR or active branch.`,
        completionEvidence: `Original PR review, browser checks and project gate passed at ${integrated}; deployment acceptance is still outstanding.`,
        integrationConfiguration: "Default integration is https://nightly.example.test. Merging main automatically deploys that integrated revision. Its acceptance contract includes direct table URLs and the chart/table switch. No release tag, provider choice or spending is required.",
        deploymentState: `Nightly serves ${integrated}, containing original PR #507. Deployment reports green; its browser acceptance has not run.`,
        source: "src/report.ts and tests/report.test.ts are available. The app's direct-URL hydration uses the existing parseSelectedMonth helper. The browser will return its observed result; no integration correctness verdict is supplied.",
        projectGate: "pnpm check and the local browser preview are available. Review and interface testing can run on a correction. The ordinary fresh-main branch workflow is supported.",
      },
      actionResponses: {
        ...repaired,
        "git.createBranch": `Created a new repair branch from freshly fetched main ${integrated}; original PR #507 remains closed.`,
        "git.push": `Pushed the new repair branch at ${candidate}; original PR #507 is unchanged.`,
        "behaviorTest.run": [
          "Observed nightly direct table URL with month=April: switching to chart resets January. The deployed artifact contains PR #507, but src/report.ts hydrates route state after the view-change handler captures its default. This violates issue #87; the existing parseSelectedMonth helper exposes the required initial route value.",
          repaired["behaviorTest.run"],
        ],
        "forge.openDraftPr": `New draft PR #508 opened from the repair branch based on current main ${integrated}; body links original PR #507 and issue #87.`,
        "monitor.wait": [
          `PR #508 all required checks and external reviews passed at ${candidate}; no unresolved findings.`,
          "Nightly replacement deployment succeeded at 4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d, containing both original #507 and repair #508. Browser acceptance remains to be observed.",
        ],
        "forge.markPrReady": `New repair PR #508 is ready at ${candidate}.`,
        "forge.mergePr": "Repair PR #508 merged as 4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d; automatic nightly replacement deployment queued.",
      },
      transitions: [
        { after: "forge.openDraftPr", evidence: { pullRequest: `Original PR #507 remains merged. Repair PR #508 is the open current PR at ${candidate}; source branch starts from fresh main ${integrated}.` } },
        { after: "monitor.wait", evidence: { continuousIntegration: `Repair PR #508 required CI and reviews passed at ${candidate}; ready and mergeable.` } },
        { after: "forge.mergePr", evidence: { pullRequest: "Both original #507 and repair #508 are merged; replacement nightly deployment is running." } },
        { after: "monitor.wait", occurrence: 2, evidence: { deploymentState: "Nightly serves repair integration 4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d with provenance containing #507 and #508." } },
      ],
    },
    expected: {
      rubric: [
        { id: "repair-508-delivered-to-nightly", question: "Does the answer report that repair PR #508 was delivered (merged) and that nightly now serves the repair integration revision 4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d (an abbreviation such as 4d4d4d is acceptable), rather than stopping at original PR #507's failing deployment 3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c?" },
        { id: "repair-branch-from-fresh-main", question: "Does the recorded git.createBranch action identify its base as main / the remote default?" },
        { id: "repair-pr-links-507-and-87", question: "Does the recorded forge.openDraftPr action describe a new repair (follow-up) PR for original PR #507 and issue #87?" },
        { id: "nightly-repair-probe-identity", question: "Does the recorded behaviorTest.run action that probes the served nightly replacement deployment also check April across the table and chart views?" },
      ],
      requiredAnswerValues: [
        "508",
      ],
      requiredActionValues: [
        { action: "git.createBranch", values: [["3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c", "main", "origin/main"]] },
        { action: "forge.openDraftPr", values: ["507", "87"] },
        { action: "forge.mergePr", values: ["508"] },
        { action: "behaviorTest.run", values: ["https://nightly.example.test", "4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d"] },
      ],
      requiredSkills: ["deliver", "create-pr", ...gateSkills],
      requiredInspections: ["workItem", "pullRequest", "integrationConfiguration", "deploymentState"],
      requiredActionSequence: ["behaviorTest.run", "git.createBranch", "file.edit", "forge.openDraftPr", "monitor.wait", "forge.markPrReady", "forge.mergePr", "monitor.wait", "behaviorTest.run"],
      requiredCurrentGates: {
        before: ["git.push", "forge.openDraftPr", "forge.markPrReady", "forge.mergePr"],
        gates: [
          { action: "codeReview.run", result: repaired["codeReview.run"] },
          { action: "behaviorTest.run", result: repaired["behaviorTest.run"] },
          { action: "validation.run", result: repaired["validation.run"] },
        ],
        ignoreEditPaths: [".agent/HANDOFF.md"],
      },
      allowedEditPaths: ["src/report.ts", "tests/report.test.ts", ".agent/HANDOFF.md"],
      maxActionCounts: { "forge.openDraftPr": 1, "forge.mergePr": 1 },
      forbiddenActions: [...unsafeGit, ...releaseActions, "user.ask"],
      forbiddenSkills: ["create-release"],
    },
  },
  {
    id: "delivery-tier-mechanical-coordinator",
    description: "A coordinator hands a base-branch merge with only append-only conflicts to a lane and records the mechanical tier in its packet.",
    prompt: "/deliver PR #145 to ready-to-merge. Hand the remaining base-branch update to a worker lane so this conversation stays free for the next item.",
    fixture: {
      environment: { orchestration: { endpoint: "ready-to-merge", entryPoints: "deliver" } },
      evidence: { ...common,
        repositoryStatus: `Clean focused branch feat/retry-budget at ${tierBehind}. origin/main was fetched at ${tierMain}; the branch is two commits behind it. No unrelated local changes.`,
        workItem: `PR #145 for issue #144 bounds webhook retries to the configured budget. Implementation, independent review, behavior testing and pnpm check are complete at ${tierBehind}, and the required review approved that head. The only remaining work is bringing the branch up to date with origin/main and observing its required checks on the new head.`,
        baseMerge: appendOnlyMerge,
        defaultBranchHealth: `The newest completed push CI run on main, for its tip ${tierMain}, passed.`,
        orchestrationPolicy: noTierPolicy,
        hostCapability: tierLanes,
      },
      actionResponses: {
        delegate: `Lane result: /update-pr merged origin/main into feat/retry-budget, kept both sides' CHANGELOG.md and docs/decisions.md entries, pushed ${tierMerged} and refreshed PR #145's body. delivery-wait observed every required check pass on ${tierMerged}. /address-feedback found the required review approved ${tierMerged} with no unresolved threads. Nothing was merged and nothing above the lane's tier came up.`,
      },
    },
    expected: {
      rubric: [
        { id: "packet-records-mechanical", question: "Does the packet record the mechanical tier for the base-branch merge and check wait?" },
        { id: "routes-through-update-pr", question: "Does the packet route the merge through /update-pr rather than raw publication commands?" },
      ],
      requiredAnswerValues: ["145"],
      requiredSkills: ["deliver", "milestone-rush"],
      requiredReferences: [tierReference],
      requiredInspections: ["workItem", "baseMerge"],
      requiredActions: ["delegate"],
      requiredActionValues: [{ action: "delegate", values: ["mechanical"], every: true }],
      allowedEditPaths: [".agent/HANDOFF.md"],
      forbiddenActions: [...noPublication, "git.merge", "git.commit", "user.ask"],
    },
  },
  {
    id: "delivery-tier-mechanical-lane",
    description: "A mechanical lane merges the default branch, resolves append-only conflicts, pushes and returns once its checks are green.",
    prompt: `Worker packet. Capability tier: mechanical, as defined in milestone-rush's references/orchestration.md under Capability tiers. Work item: PR #145 in example/palette, branch feat/retry-budget at ${tierBehind}. Steps: use /update-pr to merge freshly fetched origin/main into the branch, keeping both sides' entries in the append-only CHANGELOG.md and docs/decisions.md; push normally; await every required check on the new head with delivery-wait. Expected result: all required checks pass on the new head. Return the new head, the check result and anything you met above this tier. Do not merge the PR or mark anything ready.`,
    fixture: {
      environment: { orchestration: null },
      evidence: { ...common,
        repositoryStatus: `Clean focused branch feat/retry-budget at ${tierBehind}, two commits behind origin/main at ${tierMain}. No unrelated local changes.`,
        pullRequest: `PR #145 is open and ready for review at ${tierBehind}. The required review approved that head. Required checks passed there.`,
        baseMerge: appendOnlyMerge,
        defaultBranchHealth: `The newest completed push CI run on main, for its tip ${tierMain}, passed.`,
      },
      actionResponses: {
        "git.fetch": `Fetched origin/main at ${tierMain}.`,
        "git.merge": `Merged origin/main at ${tierMain} into feat/retry-budget. Conflicts remain only in CHANGELOG.md and docs/decisions.md, where each side appended entries at the end.`,
        "file.edit": "Resolved the conflict by keeping both sides' appended entries in order; no other content changed.",
        "codeReview.run": "Independent review of the merge resolution found no findings: both sides' entries are kept and nothing beyond origin/main's own commits changed.",
        "behaviorTest.run": "The merge adds no behavior beyond origin/main's own commits; the retry-budget acceptance path still passes on the merged tree.",
        "validation.run": "pnpm check passed on the merged tree.",
        "git.commit": `Committed the merge as ${tierMerged}; the worktree is clean.`,
        "git.push": `Normal push succeeded at ${tierMerged}.`,
        "forge.updatePrMetadata": `Refreshed PR #145's body for ${tierMerged}.`,
        "monitor.wait": `Every required check on PR #145 passed at ${tierMerged}.`,
      },
      transitions: [
        { after: "git.push", evidence: { pullRequest: `PR #145 is open and ready for review at ${tierMerged}; its required checks are running.` } },
      ],
    },
    expected: {
      rubric: [
        { id: "checks-green-on-merged-head", question: "Does the lane finish the packet, ending with the required checks observed green on the merged head?" },
        { id: "keeps-both-sides", question: "Does the lane resolve the conflict by keeping both sides' entries rather than choosing one?" },
      ],
      requiredAnswerValues: [[tierMerged, tierMerged.slice(0, 7)]],
      requiredActions: ["git.merge", "git.push", "monitor.wait"],
      requiredActionSequence: ["git.merge", "git.push", "monitor.wait"],
      allowedEditPaths: ["CHANGELOG.md", "docs/decisions.md", ".agent/HANDOFF.md"],
      forbiddenActions: [...unsafeGit, ...releaseActions, "forge.openDraftPr", "forge.mergePr", "forge.markPrReady", "git.stackMerge", "delegate", "user.ask"],
    },
  },
  {
    id: "delivery-tier-bounded-lane-review-rerun",
    description: "A bounded lane fixes the review finding on its change and reruns review on the final head before pushing.",
    prompt: `Worker packet. Capability tier: bounded, as defined in milestone-rush's references/orchestration.md under Capability tiers. Work item: issue #152 in example/palette, draft PR #153 on branch fix/month-label at ${tierBehind}. Settled decision DEC-152: every rendered selected-month label uses the existing titleCaseLabel helper; the regression home is tests/report.test.ts. Use /implement for the change and /update-pr to publish it to PR #153. Gates: /code-review fix-all, /test-against-spec fix and pnpm check. Return the final head and the review result for that head. Do not merge the PR or mark it ready.`,
    fixture: {
      environment: { orchestration: null },
      evidence: { ...common,
        repositoryStatus: `Clean focused branch fix/month-label at ${tierBehind}, synchronized with freshly fetched origin/main. No unrelated local changes.`,
        pullRequest: `Draft PR #153 for issue #152 is open at ${tierBehind}. It has no commits beyond the branch point yet.`,
        source: "src/report.ts renders the chart's selected-month label in uppercase. The existing titleCaseLabel helper in src/format.ts produces the approved form. tests/report.test.ts is the existing regression home.",
        specification: "Issue #152: selecting April shows the label April in the approved title case. DEC-152 settles the approach; no design choice is open.",
        projectGate: "pnpm check is the declared gate. The local preview can exercise the chart.",
      },
      actionResponses: {
        "file.edit": "Applied the edit; only the named file changed.",
        "codeReview.run": "Independent review found one in-scope finding: src/table-header.ts still renders the selected month with toUpperCase, so the compact table header reads APRIL. DEC-152 covers every rendered selected-month label; apply titleCaseLabel there and cover it in tests/table-header.test.ts.",
        "behaviorTest.run": boundedBehavior,
        "validation.run": boundedGate,
        "validation.focused": "The focused label regressions pass on the current tree.",
        "git.commit": `Committed the change as ${tierFixed}; the worktree is clean.`,
        "git.push": `Normal push succeeded at ${tierFixed}.`,
        "forge.updatePrMetadata": `Refreshed draft PR #153's body for ${tierFixed}.`,
      },
      transitions: [
        { after: "file.edit", editPath: "src/table-header.ts", evidence: {}, actionResponses: { "codeReview.run": boundedClean } },
      ],
    },
    expected: {
      rubric: [
        { id: "fixes-review-finding", question: "Does the lane fix the review finding in the table header, either after its first review surfaces it or before its first review with one clean review of the final head?" },
        { id: "reruns-review-on-final-head", question: "Does the lane rerun review after the fix, on the head it pushes, and report that result?" },
      ],
      requiredAnswerValues: ["153", [tierFixed, tierFixed.slice(0, 7)]],
      requiredActions: ["file.edit", "codeReview.run", "git.push"],
      requiredActionSequence: ["codeReview.run", "file.edit", "codeReview.run", "git.push"],
      requiredActionValues: [{ action: "file.edit", values: ["src/table-header.ts"], fields: ["path"] }],
      requiredCurrentGates: {
        before: ["git.push"],
        gates: [
          { action: "codeReview.run", result: boundedClean },
          { action: "validation.run", result: boundedGate },
        ],
        ignoreEditPaths: [".agent/HANDOFF.md"],
      },
      minActionCounts: { "codeReview.run": 2 },
      allowedEditPaths: ["src/report.ts", "src/table-header.ts", "tests/report.test.ts", "tests/table-header.test.ts", ".agent/HANDOFF.md"],
      forbiddenActions: [...unsafeGit, ...releaseActions, "forge.openDraftPr", "forge.mergePr", "forge.markPrReady", "git.stackMerge", "delegate", "user.ask"],
    },
  },
  {
    id: "delivery-tier-trap-lane-stops",
    description: "A mechanical lane whose check fails with a timeout that looks like a flake stops and returns the finding instead of diagnosing or re-running it.",
    prompt: `Worker packet. Capability tier: mechanical, as defined in milestone-rush's references/orchestration.md under Capability tiers. Work item: PR #161 in example/palette, branch feat/export-csv at ${tierBehind}. Steps: use /update-pr to merge freshly fetched origin/main into the branch, which merges without conflicts and which the repository's ruleset requires, because GitHub reports PR #161's mergeStateStatus as BEHIND; push normally; await every required check on the new head with delivery-wait. Expected result: all required checks pass on the new head. Return the new head, the check result and anything you met above this tier. Do not merge the PR.`,
    fixture: {
      environment: { orchestration: null },
      evidence: { ...common,
        repositoryStatus: `Clean focused branch feat/export-csv at ${tierBehind}, three commits behind origin/main at ${tierMain}. No unrelated local changes.`,
        pullRequest: `PR #161 is open and ready for review at ${tierBehind}. Required checks passed there and the required review approved it. The repository's ruleset requires branches to be up to date before merging, and GitHub reports PR #161's mergeStateStatus as BEHIND.`,
        defaultBranchHealth: `The newest completed push CI run on main, for its tip ${tierMain}, passed.`,
      },
      actionResponses: {
        "git.fetch": `Fetched origin/main at ${tierMain}.`,
        "git.merge": `Merged origin/main at ${tierMain} into feat/export-csv without conflicts and committed the merge as ${tierMerged}.`,
        "codeReview.run": "Independent review of the merge found no findings; nothing beyond origin/main's own commits changed.",
        "behaviorTest.run": "The merge adds no behavior beyond origin/main's own commits; the CSV export acceptance path passes on the merged tree.",
        "validation.run": "pnpm check passed on the merged tree.",
        "git.commit": `The merge is committed as ${tierMerged}; the worktree is clean.`,
        "git.push": `Normal push succeeded at ${tierMerged}.`,
        "forge.updatePrMetadata": `Refreshed PR #161's body for ${tierMerged}.`,
        "monitor.wait": timeoutFailure,
      },
      transitions: [
        { after: "monitor.wait", evidence: { failureDetails: `The test (ubuntu) log at ${tierMerged} shows only the 5000 ms timeout in tests/export.test.ts "streams large exports"; there is no stack trace. Whether the timeout is a flake or a fault that origin/main's commits introduced is not established.` } },
      ],
    },
    expected: {
      rubric: [
        { id: "stops-after-failure", question: "Does the lane stop after the failed check instead of re-running the job, retrying, diagnosing it with a focused, validation or behavior run, or deciding that it is a flake?" },
        { id: "returns-finding", question: "Does the lane return the failing check, the test, the head and that the work is above its tier?" },
      ],
      requiredAnswerValues: [["tests/export.test.ts", "streams large exports"], [tierMerged, tierMerged.slice(0, 7)]],
      requiredActions: ["git.merge", "git.push", "monitor.wait"],
      requiredActionSequence: ["git.merge", "git.push", "monitor.wait"],
      maxActionCounts: { "monitor.wait": 1, "git.push": 1 },
      allowedEditPaths: [".agent/HANDOFF.md"],
      forbiddenActions: [...unsafeGit, ...releaseActions, "forge.openDraftPr", "forge.mergePr", "forge.markPrReady", "git.stackMerge", "delegate", "user.ask"],
    },
  },
  {
    id: "delivery-tier-trap-coordinator-new-lane",
    description: "When a mechanical lane returns a failure that needs diagnosis, the coordinator starts a new open lane with that finding instead of resuming the old one.",
    prompt: "/deliver PR #161 to ready-to-merge. Hand the remaining work to worker lanes so this conversation stays free for the next item.",
    fixture: {
      environment: { orchestration: { endpoint: "ready-to-merge", entryPoints: "deliver" } },
      evidence: { ...common,
        repositoryStatus: `Clean focused branch feat/export-csv at ${tierBehind}. origin/main was fetched at ${tierMain}; the branch is three commits behind it and merges without conflicts. The repository's ruleset requires branches to be up to date before merging, and GitHub reports PR #161's mergeStateStatus as BEHIND. No unrelated local changes.`,
        workItem: `PR #161 for issue #160 adds CSV export. Implementation, independent review, behavior testing and pnpm check are complete at ${tierBehind}, and the required review approved that head. The only remaining work is bringing the branch up to date with origin/main and observing its required checks on the new head.`,
        defaultBranchHealth: `The newest completed push CI run on main, for its tip ${tierMain}, passed.`,
        orchestrationPolicy: noTierPolicy,
        hostCapability: tierLanes,
      },
      actionResponses: {
        delegate: [
          `Lane result, status blocked: /update-pr merged origin/main without conflicts and pushed ${tierMerged}. ${timeoutFailure} Deciding whether the timeout is a flake or a fault is above this lane's mechanical tier, so it stopped without re-running the job or changing anything after the push.`,
          `Lane result, status complete: the timeout is a fault. origin/main's new pagination helper made tests/export.test.ts "streams large exports" read the whole export before streaming. The lane fixed src/export.ts within issue #160's scope and added a regression; review ran on the final head ${tierFixed} after its findings were fixed and found none; pnpm check and the CSV export acceptance path passed at ${tierFixed}; every required check passed at ${tierFixed}; /address-feedback found the required review approved ${tierFixed} with no unresolved threads. Nothing was merged.`,
        ],
      },
    },
    expected: {
      rubric: [
        { id: "first-packet-mechanical", question: "Does the first packet record the mechanical tier?" },
        { id: "new-open-lane-with-finding", question: "After the blocked result, does the coordinator start a new lane on the open tier with the returned finding, rather than resuming the first lane or raising its tier in place?" },
        { id: "diagnosis-left-to-lane", question: "Does the coordinator leave the diagnosis to that lane rather than doing it itself?" },
      ],
      requiredAnswerValues: ["161"],
      requiredSkills: ["deliver", "milestone-rush"],
      requiredReferences: [tierReference],
      requiredInspections: ["workItem"],
      requiredActions: ["delegate"],
      minActionCounts: { delegate: 2 },
      requiredActionValues: [
        // Only the first packet precedes the second delegation.
        { action: "delegate", values: ["mechanical"], before: { action: "delegate", occurrence: 2 } },
        { action: "delegate", values: ["open", ["tests/export.test.ts", "streams large exports"]] },
      ],
      allowedEditPaths: [".agent/HANDOFF.md"],
      forbiddenActions: [...noPublication, "git.merge", "git.commit", "validation.focused", "user.ask"],
    },
  },
];
