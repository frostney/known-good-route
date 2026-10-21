import type { EvalCase } from "./types.ts";

const createEvidence = {
  repositoryStatus: "Fixture repository example/report-ui. Ordinary branch feature/report-filter is clean, already committed, tracks origin/feature/report-filter and is ahead of freshly fetched origin/main. No native stack, unrelated work or existing PR. Head 1111111111111111111111111111111111111111. Publication and readiness are authorized.",
  projectDefinitions: "The repository requires a passed independent code review, observed behavior evidence and project gate on current content, followed by exact-head CI. No extra media gate or approval requirement. The supplied evidence satisfies the implementation requirements.",
  completionEvidence: "Independent code review, actual browser behavior checks and the declared local gate passed on head 1111111111111111111111111111111111111111 in the current environment. No changes followed. These are observed fixture results, not pending requests.",
  relatedWork: "Open/closed issue search and available sibling-session/adjacent-branch inspection are complete: no duplicate or linked issue exists. The final diff is the claim source.",
  publicationGuard: "Observed result of every git-workflow publication guard run for this change (staged, outgoing and pr): the repository is public, exit 0, nothing to rewrite, no warnings. These are observed fixture results; no rerun is needed.",
};
const createResponses = {
  "git.fetch": "Fetched origin/main; branch and base unchanged.",
  "git.push": "Ordinary push confirmed current head 1111111111111111111111111111111111111111.",
  "forge.openDraftPr": "Created draft https://github.com/example/report-ui/pull/71 at head 1111111111111111111111111111111111111111 with the submitted title/body. No attachments were uploaded.",
  "forge.updatePrMetadata": "PR #71 now contains the submitted title/body at the same head.",
  "monitor.wait": "Foreground checks-terminal returned success: all required checks passed on PR #71 head 1111111111111111111111111111111111111111.",
  "forge.markPrReady": "PR #71 is now ready, open and unmerged at the verified head.",
} as const;
const forbiddenPublicationExtras = ["git.commit", "git.amend", "git.forcePush", "git.rebase", "forge.mergePr", "user.ask", "validation.run", "delegate"] as const;

export const prWritingCases: EvalCase[] = [
  {
    id: "pr-writing-ui-media-unavailable",
    description: "A completed UI change publishes while accurately reporting missing media capabilities and baseline.",
    prompt: "/create-pr for the completed report-filter change. Use the supplied fixture sources for repository state and current tool capabilities.",
    fixture: { environment: { orchestration: { endpoint: "deployed", entryPoints: "stop" } }, evidence: { ...createEvidence,
      finalDiff: "The report page now preserves the selected month when users switch between chart and table. Previously each switch reset the month to January. This is the complete aggregate change; no benchmark claim.",
      template: "No mandatory PR template. Write the body in the forge action's data.body and title in data.title so the fixture records the actual proposed text.",
      mediaCapabilities: "Observed headless Linux Wayland session. No supported screen/headless recorder, speech synthesizer, audio inspector, video assembler or subtitle renderer is installed. Installed gh help exposes no attachment support and no alternative upload connector exists. Browser interaction tests already passed but produced no recordings or images. The target-branch baseline cannot be launched or captured in this session.",
      setupDocumentation: "Current locally supplied primary-tool documentation: this host requires an authorized headless browser recording tool or enabled Wayland ScreenCast portal for capture; eSpeak NG can provide local voice synthesis after installation; an FFmpeg build with ffprobe, the needed codecs and subtitles filter provides duration inspection, assembly and burnt-in captions. Installations and portal permission changes need the user to arrange them. A supported GitHub attachment client or browser upload session must be configured separately. A runnable target-branch preview is needed for baseline capture. No setup execution capability exists in this fixture.",
      pullRequest: "No PR yet. After creation, metadata and diff match the submitted change; the only absent supporting material is the disclosed media.",
    }, actionResponses: createResponses },
    expected: {
      rubric: [
        { id: "body-describes-change", question: "Does the body of the recorded forge.openDraftPr action describe the change as the report page now keeping the selected month when switching between the chart and table views (previously it reset to January)?" },
        { id: "body-discloses-missing-media", question: "Does the recorded PR body briefly state that before/after media or a walkthrough is not included (unavailable), rather than presenting a comparison or video as provided or linking local files?" },
        { id: "handoff-media-gaps-remedies", question: "Does the final response name the incomplete media requirements (no before/after comparison including the target-branch baseline, no narrated/subtitled walkthrough, no attachment upload), give the observed reason (headless Wayland session without recorder, speech synthesizer, video assembler/subtitle renderer or gh attachment support; baseline cannot be launched), and give concrete remedies such as enabling a headless browser recorder or the Wayland ScreenCast portal, installing eSpeak NG and an FFmpeg build with ffprobe/subtitles, configuring a GitHub attachment client, or providing a runnable target-branch preview?" },
        { id: "pr-ready-not-blocked", question: "Does the final response report that PR #71 was published and marked ready for review after the required checks passed on its current head (the media gap did not keep it draft), without claiming it was merged?" },
      ],
      requiredAnswerValues: [
        "71",
      ],
      requiredActionValues: [
        { action: "monitor.wait", values: ["1111111111111111111111111111111111111111"] },
      ],
      requiredSkills: ["create-pr"],
      requiredReferences: ["create-pr/references/walkthroughs.md", "agent-writing/references/pr-descriptions.md"],
      requiredInspections: ["finalDiff", "template", "mediaCapabilities", "setupDocumentation"],
      requiredActions: ["forge.openDraftPr", "monitor.wait", "forge.markPrReady"],
      forbiddenActions: [...forbiddenPublicationExtras, "file.edit", "behaviorTest.run"],
    },
  },
  {
    id: "pr-writing-docs-required-template",
    description: "A small documentation PR preserves its required Testing heading without manufacturing a walkthrough.",
    prompt: "/create-pr for the completed configuration-documentation correction.",
    fixture: { environment: { orchestration: { endpoint: "deployed", entryPoints: "stop" } }, evidence: { ...createEvidence,
      finalDiff: "Only docs/configuration.md changes: clarify that cache.enabled=false bypasses cache reads and writes. Before, the guide incorrectly said it disabled writes only. No runtime behavior changes or workflow demonstration is needed.",
      template: "The explicit repository PR template requires exactly the headings ## Summary and ## Testing. Testing must state the observed docs-link check result. Put the complete body in data.body and title in data.title of the forge action. This template requirement applies even to documentation-only changes.",
      completionEvidence: "Independent documentation review passed on current head. docs:links passed with zero broken links. The implementation caller confirmed the wording matches existing behavior. No runtime change requires additional behavior testing.",
      mediaCapabilities: "No existing recording. The change corrects one sentence; there is no meaningful changed workflow to demonstrate.",
      pullRequest: "No PR yet. Post-publication metadata/diff match the submitted documentation correction and required template.",
    }, actionResponses: createResponses },
    expected: {
      rubric: [
        { id: "summary-cache-reads-writes", question: "Does the recorded PR body explain that the docs/configuration.md correction says cache.enabled=false bypasses both cache reads and cache writes (the guide previously said it disabled writes only)?" },
        { id: "testing-link-check", question: "Does the Testing section of the recorded PR body state the observed docs link check result (docs:links passed with zero broken links)?" },
        { id: "pr-ready", question: "Does the final response report that PR #71 was opened and marked ready for review after the required checks passed, without claiming it was merged?" },
      ],
      requiredAnswerValues: [
        "71",
      ],
      requiredActionValues: [
        { action: "forge.openDraftPr", values: ["## Summary", "## Testing"] },
      ],
      requiredSkills: ["create-pr"], requiredReferences: ["agent-writing/references/pr-descriptions.md"],
      requiredInspections: ["finalDiff", "template", "completionEvidence"],
      requiredActions: ["forge.openDraftPr", "monitor.wait", "forge.markPrReady"],
      forbiddenActions: [...forbiddenPublicationExtras, "file.edit", "behaviorTest.run"],
    },
  },
  {
    id: "pr-writing-performance-update",
    description: "A performance PR update describes the final aggregate change with a visible comparable benchmark table.",
    prompt: "Do /update-pr 72 using the prepared final change and measurements.",
    fixture: { environment: { orchestration: { endpoint: "deployed", entryPoints: "stop" } }, evidence: {
      repositoryStatus: "Ordinary open PR #72 in example/parser, branch perf/name-lookup, correct selected target. The remote default is freshly fetched and already integrated. Relevant implementation changes are committed and pushed at 2222222222222222222222222222222222222222. Clean worktree, no native stack, no conflicts or unrelated changes. Only PR metadata is stale.",
      pullRequest: "Current PR title: chore: delete prototype lookup wrapper. Old body: We first added a wrapper, then removed 480 lines, reverted the cache prototype and reran tests five times. Open and unmerged. Current-head CI is pending, not passed.",
      finalDiff: "Against target main 3333333333333333333333333333333333333333, final candidate 2222222222222222222222222222222222222222 reuses the existing interned-name index for repeated identifier lookup. Observable results are unchanged; repeated-name parsing is faster. The temporary wrapper/cache and development line-count reduction do not exist in the final diff and explain no remaining tradeoff.",
      benchmark: "Paired observed measurements: target main 3333333333333333333333333333333333333333 median parse time 100 ms; final candidate 2222222222222222222222222222222222222222 median 70 ms. Same Apple M3 host, Node 24.18.0, release build, fixed 10,000-name corpus, 15 alternating warm runs per revision. Results are deterministic and matched for every run; timing spread is 2 ms on each side. No memory measurement was taken.",
      projectGate: "Independent review, exact-content CLI behavior checks and the declared full local gate passed on the current unchanged candidate in the same environment. No rerun is needed. Current-head remote CI remains pending.",
      template: "No required headings or routine testing section. Record the complete replacement body in data.body and title in data.title when updating metadata.",
      mediaCapabilities: "This internal lookup optimization has no additional meaningful visual or CLI workflow demonstration beyond the benchmark. No video is required by project policy.",
      publicationGuard: "Observed result of every git-workflow publication guard run for this update (outgoing and pr): the repository is public, exit 0, nothing to rewrite, no warnings. These are observed fixture results; no rerun is needed.",
    }, actionResponses: {
      "git.fetch": "Fetched remote default; unchanged.",
      "git.push": "Remote already has the candidate; no new commit.",
      "forge.updatePrMetadata": "PR #72 title/body replaced by the supplied final aggregate description. CI remains pending; PR remains open and unmerged.",
    } },
    expected: {
      rubric: [
        { id: "benchmark-table", question: "Does the body of the recorded forge.updatePrMetadata action contain a visible (not collapsed) before/after table comparing the median parse time of target main (3333333...) with that of the PR candidate (2222222...)?" },
        { id: "benchmark-conditions", question: "Does the recorded PR body state the measurement conditions that make the comparison meaningful, including the fixed name corpus and the number of alternating warm runs per revision (other conditions such as the Apple M3 host, Node 24.18.0 and release build may also appear)?" },
        { id: "final-aggregate-change", question: "Does the recorded PR body describe the final change (reusing the existing interned-name index for repeated identifier lookup, observable results unchanged) instead of recounting development history such as the temporary wrapper, the 480-line removal, the reverted cache prototype or the five test reruns?" },
        { id: "ci-pending-open", question: "Does the final response report that PR #72's metadata was updated while current-head CI is still pending and the PR remains open and unmerged, rather than claiming CI passed, the PR is ready, or it was merged?" },
        { id: "body-structure", question: "Is the recorded PR body laid out in this order: a short What changed summary, a collapsed <details> block, a Visual walkthrough section holding the benchmark table, and a How to test section of bullets that each give a step and its expected result?" },
        { id: "body-no-author-verification", question: "Does the recorded PR body leave out the author's own verification, with no section, collapsed block or sentence reporting that the review, the CLI behavior checks or the project gate passed, while counting benchmark results and conditions (including that parse output matched across benchmark runs) as part of the claim rather than as verification?" },
      ],
      requiredAnswerValues: [
        "72",
      ],
      requiredActionValues: [
        { action: "forge.updatePrMetadata", values: [["100","100ms"], ["70","70ms"], ["10,000","10000","10k"], "15", "## What changed", "<details>", "## Visual walkthrough", "## How to test"] },
      ],
      requiredSkills: ["update-pr"], requiredReferences: ["agent-writing/references/pr-descriptions.md"],
      requiredInspections: ["finalDiff", "benchmark", "projectGate", "template"],
      requiredActions: ["forge.updatePrMetadata"], forbiddenActions: [...forbiddenPublicationExtras, "file.edit", "forge.markPrReady"],
    },
  },
  {
    id: "pr-writing-structured-body",
    description: "A CLI change gets the What changed, Details, Visual walkthrough and How to test structure without the author's verification.",
    prompt: "/create-pr for the completed report-export change.",
    fixture: { environment: { orchestration: { endpoint: "deployed", entryPoints: "stop" } }, evidence: { ...createEvidence,
      relatedWork: "Open/closed issue search and available sibling-session/adjacent-branch inspection are complete. Issue #40 asks for a date filter on report export; this change completes it. No duplicate exists. The final diff is the claim source.",
      finalDiff: "The `report export` CLI now accepts `--since YYYY-MM-DD` and exports only rows dated on or after that day. Previously it always exported every row. An invalid date exits with status 2 and names the flag. The filter runs before formatting, so CSV and JSON output both honor it. This is the complete aggregate change; no benchmark claim.",
      completionEvidence: "Independent code review passed. `bun test` passed with 412 tests and exit 0. Eight revert probes each removed one rule and the tests caught all eight. CLI behavior checks against the fixture database passed. All on head 1111111111111111111111111111111111111111 in the current environment; no changes followed.",
      template: "No mandatory PR template. Write the body in the forge action's data.body and title in data.title so the fixture records the actual proposed text.",
      mediaCapabilities: "No screen recorder or attachment upload is available. This is a terminal-only change; a plain-text CLI session is the clearest demonstration. `report export --db PATH` selects a database and `--format csv|json` selects the output format (default csv). The sample database `examples/sales.db` ships in the repository and has rows from 2026-01-01 to 2026-03-31.",
      pullRequest: "No PR yet. After creation, metadata and diff match the submitted change.",
    }, actionResponses: createResponses },
    expected: {
      rubric: [
        { id: "body-order", question: "Is the body of the recorded forge.openDraftPr action laid out in this order: a What changed section, then a Closes line for issue 40, then a collapsed <details> block, then a Visual walkthrough section, then a How to test section?" },
        { id: "summary-short", question: "Is the What changed section a brief summary of the problem and the new --since behavior (a few sentences, roughly 80 words or fewer), with design rationale and limits left to the <details> block?" },
        { id: "walkthrough-cli-session", question: "Does the Visual walkthrough section show a CLI session or example that runs report export with --since against examples/sales.db and shows or describes what it outputs?" },
        { id: "how-to-test-runnable", question: "Is How to test a list of bullets that a person or agent could follow from the PR branch, each giving an exact command or input and its expected result, including a report export --since run against examples/sales.db?" },
        { id: "body-no-author-verification", question: "Does the PR body leave out the author's own verification, with no section, collapsed block or sentence reporting the review result, the 412 tests, the revert probes or the behavior checks that were run?" },
        { id: "handoff-validation", question: "Does the final response report the supplied validation (the independent review, the test run and the behavior checks) and that the PR was published and marked ready for review, without claiming it was merged?" },
      ],
      requiredAnswerValues: [
        "71",
      ],
      requiredActionValues: [
        { action: "forge.openDraftPr", values: ["## What changed", "Closes #40", "<details>", "## Visual walkthrough", "## How to test"] },
        { action: "monitor.wait", values: ["1111111111111111111111111111111111111111"] },
      ],
      requiredSkills: ["create-pr"], requiredReferences: ["agent-writing/references/pr-descriptions.md"],
      requiredInspections: ["finalDiff", "template", "completionEvidence", "relatedWork", "mediaCapabilities"],
      requiredActions: ["forge.openDraftPr", "monitor.wait", "forge.markPrReady"],
      forbiddenActions: [...forbiddenPublicationExtras, "file.edit", "behaviorTest.run"],
    },
  },
  {
    id: "pr-writing-reuse-complete-walkthrough",
    description: "Reuse current narrated/subtitled walkthrough and comparable images, and verify reviewer-accessible uploads.",
    prompt: "/create-pr for the completed report-filter change. The implementation already retained its demonstration artifacts.",
    fixture: { environment: { orchestration: { endpoint: "deployed", entryPoints: "stop" } }, evidence: { ...createEvidence,
      finalDiff: "The report page preserves the selected month when switching chart/table; previously it reset to January. The final diff changes only that behavior.",
      template: "No mandatory headings. Put full PR text in data.body, title in data.title and local attachment paths in data.attachments of forge.openDraftPr. These are fixture arguments for a supported upload operation.",
      mediaCapabilities: "Observed supported attachment client accepts PNG with #alt text and MP4 plain paths. Current recording /tmp/report-filter.mp4 was exported from the real validated scenario at the exact current revision. It shows selecting April, switching chart/table, and the month staying April. English voice-over, burnt-in subtitles from the same script and measured segment timings are present. Playback was inspected: text readable, audio intelligible, captions synchronized, behavior matches narration. Before and after images /tmp/report-before.png and /tmp/report-after.png show comparable viewport/data on target main and current candidate. All files are outside the repository. This observation is existing implementation evidence; no new recording or export is necessary.",
      pullRequest: "No PR yet; inspect publishedAssets after creating it to verify reviewer access and retrieve URLs for the final body.",
      publishedAssets: "No uploaded assets exist before creation.",
    }, actionResponses: { ...createResponses,
      "forge.openDraftPr": "Draft PR #71 created at current head with three requested attachments: report-before.png, report-after.png and report-filter.mp4. Inspect publishedAssets for the observed links and playback result.",
    }, transitions: [{ after: "forge.openDraftPr", evidence: {
      publishedAssets: "Actual PR attachment inspection confirms all assets are accessible to repository reviewers. Before: https://github.com/user-attachments/assets/before71.png. After: https://github.com/user-attachments/assets/after71.png. Video: https://github.com/user-attachments/assets/walkthrough71.mp4. Embedded PR video playback has the same intelligible voice-over, readable burnt-in subtitles and synchronization as the inspected local export. The uploaded stills retain the comparable viewport/data.",
    } }] },
    expected: {
      rubric: [
        { id: "attachments-requested", question: "Does the recorded forge.openDraftPr action request all three existing assets (the before image, the after image and the walkthrough video) as attachments?" },
        { id: "body-comparison-table", question: "Does the body of the recorded forge.updatePrMetadata action contain a labelled before/after table using the uploaded image URLs (not local /tmp paths)?" },
        { id: "body-walkthrough-link", question: "Does the recorded forge.updatePrMetadata body include the uploaded walkthrough video (not a local /tmp path)?" },
        { id: "pr-ready", question: "Does the final response report that PR #71 was marked ready for review after the required checks passed, with the uploaded before/after images and narrated walkthrough verified as accessible to reviewers, without claiming it was merged?" },
      ],
      requiredAnswerValues: [
        "71",
      ],
      requiredActionValues: [
        { action: "forge.openDraftPr", values: ["/tmp/report-before.png", "/tmp/report-after.png", "/tmp/report-filter.mp4"] },
        { action: "forge.updatePrMetadata", values: ["https://github.com/user-attachments/assets/before71.png", "https://github.com/user-attachments/assets/after71.png", "https://github.com/user-attachments/assets/walkthrough71.mp4"] },
      ],
      requiredSkills: ["create-pr"], requiredReferences: ["create-pr/references/walkthroughs.md", "agent-writing/references/pr-descriptions.md"],
      requiredInspections: ["mediaCapabilities", "publishedAssets"],
      requiredActions: ["forge.openDraftPr", "forge.updatePrMetadata", "monitor.wait", "forge.markPrReady"],
      forbiddenActions: [...forbiddenPublicationExtras, "file.edit", "behaviorTest.run"],
      requiredActionsBeforeActions: [{ before: "forge.openDraftPr", after: "forge.updatePrMetadata" }],
    },
  },
];
