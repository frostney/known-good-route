import { expect, test } from "bun:test";
import { createFixtureState } from "./fixture-state.ts";
import { gradeRun } from "./grading.ts";
import { prWritingCases } from "./pr-writing-cases.ts";
import type { RunLedger } from "./types.ts";

const media = prWritingCases.find((c) => c.id === "pr-writing-reuse-complete-walkthrough")!;
const failed = (actions: RunLedger["actions"], inspected = ["mediaCapabilities", "publishedAssets"]) =>
  gradeRun(
    media,
    {
      actions,
      loadedSkills: ["create-pr"],
      loadedReferences: ["create-pr/references/walkthroughs.md", "agent-writing/references/pr-descriptions.md"],
      registeredSkillCalls: [],
      inspections: inspected,
      // The assets are inspected right after the creation that uploads them.
      events: [
        { kind: "inspection", name: "mediaCapabilities" },
        ...actions.flatMap((a, index) => [
          { kind: "action" as const, name: a.action },
          ...(index === actions.findIndex((b) => b.action === "forge.openDraftPr")
            ? inspected.filter((name) => name !== "mediaCapabilities").map((name) => ({ kind: "inspection" as const, name }))
            : []),
        ]),
      ],
    },
    "PR #71 is ready for review with the before/after images and the narrated walkthrough uploaded and verified.",
  )
    .checks.filter((c) => !c.passed)
    .map((c) => c.name);

const files = ["/tmp/report-before.png", "/tmp/report-after.png", "/tmp/report-filter.mp4"];
const body = `| Before | After |\n| --- | --- |\n| ![Before](${files[0]}) | ![After](${files[1]}) |\n\n![Walkthrough](<${files[2]}>)`;
const open = {
  action: "forge.openDraftPr" as const,
  details: "gh pr create --draft --body-file body.md with three --attach",
  data: { title: "fix(report): keep the selected month when switching views", body, attachments: files },
};
const wait = { action: "monitor.wait" as const, details: "checks on the head" };
const ready = { action: "forge.markPrReady" as const, details: "PR #71" };
const attachmentsCheck = `forge.openDraftPr carries ${files.join(", ")}`;
const bodyCheck = `forge.openDraftPr carries ${files.map((f) => `](${f}) | ](<${f}>)`).join(", ")}`;

test("the media case passes when the PR opens with its media in the body", () => {
  expect(failed([open, wait, ready])).toEqual([]);
  // Alt text given with the attachment still names the attached file.
  expect(failed([{ ...open, data: { ...open.data, attachments: files.map((f) => `${f}#Alt text`) } }, wait, ready])).toEqual([]);
});

test("a review note updated after CI is not a second media write", () => {
  const note = { action: "forge.updatePrMetadata" as const, details: "update the review note in place", data: { reviewNote: "CI passed on 1111111." } };
  expect(failed([open, wait, note, ready])).toEqual([]);
});

test("the media case fails a PR opened without its media", () => {
  // Naming the paths in the details does not attach them.
  expect(failed([{ ...open, details: `attach ${files.join(" ")}`, data: { ...open.data, body: "Keeps the month.", attachments: [] } }, wait, ready]))
    .toEqual([attachmentsCheck, bodyCheck]);
});

test("the media case fails a file that is attached but not referenced in the body", () => {
  const bare = body.replace(`![Walkthrough](<${files[2]}>)`, files[2]!);
  expect(failed([{ ...open, data: { ...open.data, body: bare } }, wait, ready])).toEqual([bodyCheck]);
});

test("the media case fails a second creation and readiness before checks or asset inspection", () => {
  expect(failed([open, open, wait, ready])).toEqual(["maximum forge.openDraftPr"]);
  expect(failed([open, ready, wait])).toEqual(["required action sequence"]);
  expect(failed([open, wait, ready], ["mediaCapabilities"])).toEqual(
    expect.arrayContaining(["required inspections", "publishedAssets before forge.markPrReady"]),
  );
});

test("the fixture reports uploads only when the creation attached every file", () => {
  const attached = createFixtureState(media.fixture);
  attached.record("forge.openDraftPr", open.data, open.details);
  expect(attached.evidence.publishedAssets).toContain("accessible to repository reviewers");
  const none = createFixtureState(media.fixture);
  none.record("forge.openDraftPr", { ...open.data, attachments: [] }, `attach ${files.join(" ")}`);
  expect(none.evidence.publishedAssets).toContain("no uploaded files");
});
