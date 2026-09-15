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

export const deliveryCases: EvalCase[] = [
  {
    id: "delivery-implement-development-only",
    description: "Standalone implementation completes the specified development and fidelity work without entering publication.",
    prompt: "/implement 81",
    fixture: {
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
      requiredActionDetails: [
        { action: "behaviorTest.run", patterns: ["April", "chart", "table", "label|title.case|fidelity|reference"] },
      ],
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
      evidence: { ...common,
        workItem: "PR #503 is the established ordinary work item for issue #83 in example/palette, not an issue numbered 503. It fixes loading a theme fixture from paths containing spaces. Scope and the path-decoding approach were already selected.",
        pullRequest: `Existing draft PR #503 at ${before}. Required project check is pending. Existing external reviews found no unrelated issues; final approval must apply to the repaired head. There are no unresolved inline threads.`,
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
      requiredActionDetails: [{ action: "forge.markPrReady", patterns: [`\\b${candidate}\\b`], dataFields: ["head", "revision"] }],
      allowedEditPaths: ["src/theme-fixture.ts", "tests/theme-fixture.test.ts", ".agent/HANDOFF.md"],
      forbiddenActions: [...unsafeGit, ...releaseActions, "forge.openDraftPr", "forge.mergePr", "git.stackMerge", "user.ask"],
      outputPatterns: ["503"],
    },
  },
  {
    id: "delivery-default-integration-current-revision",
    description: "Default delivery reuses current gates and verifies the merged change at the configured nightly destination rather than trusting a stale green deployment.",
    prompt: "/deliver the completed report-filter work",
    fixture: {
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
      requiredSkills: ["deliver", "test-against-spec"],
      requiredInspections: ["workItem", "completionEvidence", "integrationConfiguration", "deploymentState"],
      requiredActions: ["validation.reuse"],
      requiredActionSequence: ["forge.mergePr", "monitor.wait", "monitor.wait", "behaviorTest.run"],
      requiredActionDetails: [{ action: "behaviorTest.run", patterns: ["nightly\\.example\\.test", `\\b${integrated}\\b`, "April", "chart", "table"], dataFields: ["url", "destination", "environment", "revision", "head"] }],
      maxActionCounts: { "forge.mergePr": 1 },
      forbiddenActions: [...unsafeGit, ...releaseActions, "file.edit", "git.commit", "forge.openDraftPr", "codeReview.run", "validation.run", "user.ask"],
      forbiddenSkills: ["create-release"],
      outputPatterns: ["nightly"],
    },
  },
  {
    id: "delivery-missing-integration-decision",
    description: "An unresolved integration destination does not stop independent PR preparation or justify guessed hosting and false deployment claims.",
    prompt: "/deliver the completed import-error correction",
    fixture: {
      evidence: { ...common,
        repositoryStatus: `Clean completed branch at ${candidate}; no PR exists yet. Current scope and development are settled.`,
        workItem: "Issue #85 requires JSON MissingFile with exit 2 for absent inputs and preserved valid imports. Current implementation meets both paths.",
        completionEvidence: `Independent review, built-CLI acceptance and pnpm check passed at ${candidate}; no subsequent source, environment or requirement changes.`,
        integrationConfiguration: "Complete repository instructions and workflow inspection finds only PR checks and a manually tagged production release. No default integration destination exists. The two available hosting options require different accounts and billing. Neither provider, destination nor spending has been selected, and no deployment credentials are configured.",
        projectPolicy: "An ordinary reviewed PR may be prepared independently of a hosting choice. No policy requires creating infrastructure to open the PR. No existing server or workflow can supply integration acceptance.",
        pullRequest: "No PR exists. A concise summary with Closes #85 satisfies the template. The current completed implementation has no additional useful walkthrough.",
      },
      actionResponses: {
        "forge.openDraftPr": `Draft https://github.com/example/palette/pull/505 opened at ${candidate}.`,
        "monitor.wait": `PR #505 required checks and reviews passed at ${candidate}; there are no unresolved threads.`,
        "forge.markPrReady": `PR #505 is ready at ${candidate}. Integration destination remains unset; no deployment occurred.`,
        "user.ask": "The concrete destination/provider/account decision was enqueued for the user. No answer is available in this turn.",
      },
      transitions: [{ after: "forge.openDraftPr", evidence: { pullRequest: `PR #505 exists at ${candidate}; publication metadata matches issue #85. Integration configuration remains unresolved.` } }],
    },
    expected: {
      requiredSkills: ["deliver", "create-pr"],
      requiredInspections: ["workItem", "completionEvidence", "integrationConfiguration"],
      requiredActionSequence: ["forge.openDraftPr", "monitor.wait", "forge.markPrReady", "user.ask"],
      requiredActionDetails: [{ action: "user.ask", patterns: ["integration|destination|hosting", "provider|account|billing|spend"] }],
      maxActionCounts: { "forge.openDraftPr": 1 },
      forbiddenActions: [...unsafeGit, ...releaseActions, "file.edit", "codeReview.run", "behaviorTest.run", "validation.run"],
      forbiddenSkills: ["create-release"],
      outputPatterns: ["505", "integration|destination|hosting", "pending|incomplete|blocked|unresolved|not deployed|not yet deployed"],
    },
  },
  {
    id: "delivery-milestone-release-boundary",
    description: "Milestone completion invokes the release workflow and the existing single publisher after work-item integration is verified.",
    prompt: "/milestone-rush 4.2",
    fixture: {
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
      requiredActionDetails: [{ action: "git.pushTag", patterns: ["v?4\\.2\\.0", `\\b${integrated}\\b`], dataFields: ["tag", "head", "revision"] }],
      maxActionCounts: { "git.pushTag": 1 },
      forbiddenActions: [...unsafeGit, "forge.createRelease", "forge.openDraftPr", "forge.mergePr", "validation.run", "delegate"],
      outputPatterns: ["4\\.2\\.0", "release|published"],
    },
  },
  {
    id: "delivery-post-merge-integration-repair",
    description: "A merged work item whose integration reveals a requirement gap completes through a new linked repair PR and verified replacement deployment.",
    prompt: "/deliver 507",
    fixture: {
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
      requiredActionDetails: [
        { action: "git.createBranch", patterns: ["main|remote.default", `\\b${integrated}\\b`], dataFields: ["base", "baseRef", "startPoint", "revision"] },
        { action: "forge.openDraftPr", patterns: ["507", "87", "repair|follow.up"] },
        { action: "forge.mergePr", patterns: ["508"] },
        { action: "behaviorTest.run", patterns: ["nightly\\.example\\.test", "\\b4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d\\b", "April", "table", "chart"], dataFields: ["url", "destination", "environment", "revision", "head"] },
      ],
      allowedEditPaths: ["src/report.ts", "tests/report.test.ts", ".agent/HANDOFF.md"],
      maxActionCounts: { "forge.openDraftPr": 1, "forge.mergePr": 1 },
      forbiddenActions: [...unsafeGit, ...releaseActions, "user.ask"],
      forbiddenSkills: ["create-release"],
      outputPatterns: ["508", "nightly"],
    },
  },
];
