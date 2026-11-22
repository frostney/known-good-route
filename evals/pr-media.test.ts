import { expect, test } from "bun:test";
import { gradeRun } from "./grading.ts";
import { prWritingCases } from "./pr-writing-cases.ts";
import type { RunLedger } from "./types.ts";

const media = prWritingCases.find((c) => c.id === "pr-writing-reuse-complete-walkthrough")!;
const failed = (actions: RunLedger["actions"]) =>
  gradeRun(
    media,
    {
      actions,
      loadedSkills: ["create-pr"],
      loadedReferences: ["create-pr/references/walkthroughs.md", "agent-writing/references/pr-descriptions.md"],
      registeredSkillCalls: [],
      inspections: ["mediaCapabilities", "publishedAssets"],
      events: [
        { kind: "inspection", name: "mediaCapabilities" },
        ...actions.map((a) => ({ kind: "action" as const, name: a.action })),
        { kind: "inspection", name: "publishedAssets" },
      ],
    },
    "PR #71 is ready for review with the before/after images and the narrated walkthrough uploaded and verified.",
  )
    .checks.filter((c) => !c.passed)
    .map((c) => c.name);

const files = ["/tmp/report-before.png", "/tmp/report-after.png", "/tmp/report-filter.mp4"];
const open = {
  action: "forge.openDraftPr" as const,
  details: "gh pr create --draft --body-file body.md with three --attach",
  data: {
    title: "fix(report): keep the selected month when switching views",
    body: `| Before | After |\n| --- | --- |\n| ![Before](${files[0]}) | ![After](${files[1]}) |\n\n![Walkthrough](${files[2]})`,
    attachments: files,
  },
};
const rest: RunLedger["actions"] = [
  { action: "monitor.wait", details: "checks on the head" },
  { action: "forge.markPrReady", details: "PR #71" },
];

test("the media case passes when the PR opens with its media in the body", () => {
  expect(failed([open, ...rest])).toEqual([]);
});

test("the media case fails a body written again to add media after the PR opened", () => {
  const paste = {
    action: "forge.updatePrMetadata" as const,
    details: "paste the uploaded URLs into the body",
    data: { body: "!a private repository" },
  };
  expect(failed([open, paste, ...rest])).toEqual(["forbidden actions"]);
});

test("the media case fails a PR opened without its media", () => {
  expect(failed([{ ...open, data: { ...open.data, body: "Keeps the month.", attachments: [] } }, ...rest]))
    .toEqual(["forge.openDraftPr carries /tmp/report-before.png, /tmp/report-after.png, /tmp/report-filter.mp4"]);
});
