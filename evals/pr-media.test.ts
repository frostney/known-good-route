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
const bodyCheck = `forge.openDraftPr carries ${files.map((f) => `](${f}) | ](<${f}>)`).join(", ")}, ${files[2]}`;

test("the media case passes when the PR opens with its media in the body", () => {
  expect(failed([open, wait, ready])).toEqual([]);
  // Alt text given with an image's attachment still names the attached file.
  const images = files.slice(0, 2).map((f) => `${f}#Alt text`);
  expect(failed([{ ...open, data: { ...open.data, attachments: [...images, files[2]] } }, wait, ready])).toEqual([]);
  // gh refuses alt text on a video, and a longer or prefixed path is another file.
  for (const attachments of [
    [...images, `${files[2]}#Alt text`],
    [`${files[0]}.bak`, files[1], files[2]],
    [`${files[0]}.bak#Before`, files[1], files[2]],
    [`x${files[0]}`, files[1], files[2]],
    [files.join(" ")],
  ])
    expect(failed([{ ...open, data: { ...open.data, attachments } }, wait, ready])).toEqual([attachmentsCheck]);
});

test("the media case fails a video reference gh turns into a link", () => {
  // Inline, on a line below other text in the same paragraph, in a list, or as a plain link, the video plays nowhere.
  for (const placement of [
    `Walkthrough: ![Video](${files[2]})`,
    `Watch this:\n![Video](${files[2]})`,
    `- ![Video](${files[2]})`,
    `[Video](${files[2]})`,
    `\`\`\`\n![Video](${files[2]})\n\`\`\``,
  ]) {
    const inline = body.replace(`![Walkthrough](<${files[2]}>)`, placement);
    expect(failed([{ ...open, data: { ...open.data, body: inline } }, wait, ready])).toEqual([bodyCheck]);
  }
  // Alone in its paragraph, with or without angle brackets, it plays.
  for (const alone of [`![Walkthrough](${files[2]})`, `  ![](${files[2]})  `, `![Walkthrough](${files[2]})\n\nMore text.`])
    expect(failed([{ ...open, data: { ...open.data, body: body.replace(`![Walkthrough](<${files[2]}>)`, alone) } }, wait, ready]))
      .toEqual([]);
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
    expect.arrayContaining(["required inspections", "publishedAssets after forge.openDraftPr and before forge.markPrReady"]),
  );
});

test("the fixture reports uploads only when the creation attached every file as gh accepts it", () => {
  const assets = (data: Record<string, unknown>, details = open.details) => {
    const state = createFixtureState(media.fixture);
    state.record("forge.openDraftPr", data, details);
    return state.evidence.publishedAssets;
  };
  expect(assets(open.data)).toContain("embedded as a player");
  expect(assets({ ...open.data, attachments: [`${files[0]}#Before`, `${files[1]}#After`, files[2]] })).toContain("embedded as a player");
  expect(assets({ ...open.data, attachments: [] }, `attach ${files.join(" ")}`)).toContain("no uploaded files");
  expect(assets({ ...open.data, attachments: [files[0], files[1], `${files[2]}#Video`] })).toContain("no uploaded files");
  expect(assets({ ...open.data, attachments: [`${files[0]}.bak`, files[1], files[2]] })).toContain("no uploaded files");
  // Inline markup uploads the video but shows a link, not a player.
  const inline = assets({ ...open.data, body: body.replace(`![Walkthrough](<${files[2]}>)`, `Walkthrough: ![Video](${files[2]})`) });
  expect(inline).toContain("no embedded player");
  expect(inline).not.toContain("playback");
});

test("an asset inspection before the creation does not verify the uploads", () => {
  const result = gradeRun(media, {
    actions: [open, wait, ready], loadedSkills: ["create-pr"],
    loadedReferences: ["create-pr/references/walkthroughs.md", "agent-writing/references/pr-descriptions.md"],
    registeredSkillCalls: [], inspections: ["mediaCapabilities", "publishedAssets"],
    events: [
      { kind: "inspection", name: "mediaCapabilities" }, { kind: "inspection", name: "publishedAssets" },
      { kind: "action", name: "forge.openDraftPr" }, { kind: "action", name: "monitor.wait" }, { kind: "action", name: "forge.markPrReady" },
    ],
  }, "PR #71 is ready.");
  expect(result.checks.filter((c) => !c.passed).map((c) => c.name)).toEqual(["publishedAssets after forge.openDraftPr and before forge.markPrReady"]);
});
