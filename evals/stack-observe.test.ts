import { test, expect } from "bun:test";
import { gradeStackAssessment, gradeFeedbackCensus } from "./stack-observe.ts";
const input = () => ({
  model: "claude:claude-fable-5-1",
  fixture: { repository: "frostney/test", stackNumber: 3 },
  transition: { after: "new-base" },
  native: {
    responseModels: ["claude-fable-5-1"],
    ledger: {
      loadedSkills: ["address-feedback"],
      loadedReferences: ["address-feedback/references/stack-readiness.md"],
      inspections: [
        "live-native-stack",
        "prior-checkpoint",
        "member-1",
        "member-2",
        "file-src/store.mjs",
        "file-src/batch.mjs",
        "file-AGENTS.md",
      ],
    },
  },
  assessment: {
    repository: "frostney/test",
    stack: 3,
    state: "blocked",
    baseSha: "new-base",
    invalidatedFrom: 0,
    members: [
      { pr: 1, head: "first", state: "pending" },
      { pr: 2, head: "top", state: "blocked" },
    ],
    findings: [
      { summary: "falsy", witnessIds: ["probe-0"] },
      { summary: "atomic", witnessIds: ["probe-9"] },
    ],
  },
  live: {
    observation: {
      base: { sha: "new-base" },
      comparison: { baseChanged: true },
      members: [
        { pr: 1, head: "first" },
        { pr: 2, head: "top" },
      ],
    },
  },
  gate: {
    head: "top",
    visible: { passed: true },
    probes: Array.from({ length: 20 }, (_, i) => ({
      id: `probe-${i}`,
      passed: ![0, 1, 2, 3, 9, 10, 11, 12, 13, 14].includes(i),
    })),
  },
});
test("current stack assessment requires exact live scope and real failing witnesses for both defects", () => {
  expect(gradeStackAssessment(input()).passed).toBe(true);
  for (const mutate of [
    (x: any) => (x.assessment.state = "ready"),
    (x: any) => x.assessment.members.pop(),
    (x: any) => (x.assessment.members[0].state = "covered"),
    (x: any) => x.assessment.members.reverse(),
    (x: any) => (x.live.observation.base.sha = "advanced-again"),
    (x: any) => (x.live.observation.members[1].head = "new-top"),
    (x: any) => (x.gate.head = "old-top"),
    (x: any) => (x.assessment.invalidatedFrom = 1),
    (x: any) => (x.assessment.findings[0].witnessIds = ["invented"]),
    (x: any) => (x.assessment.findings[0].witnessIds = ["probe-4"]),
    (x: any) => x.assessment.findings.pop(),
    (x: any) => (x.native.responseModels = ["claude-opus-5"]),
    (x: any) => (x.native.ledger.inspections = []),
    (x: any) => (x.native.error = "incomplete"),
  ]) {
    const x = input();
    mutate(x);
    expect(gradeStackAssessment(x).passed).toBe(false);
  }
});
test("a different executed witness for the same defect is accepted", () => {
  const x = input();
  x.assessment.findings[0]!.witnessIds = ["probe-14"];
  x.assessment.findings[1]!.witnessIds = ["probe-13"];
  expect(gradeStackAssessment(x).passed).toBe(true);
});

test("feedback census binds every surface and policy uncertainty to the current member", () => {
  const make = () => ({
    assessment: { repository: "frostney/test", feedback: [
      { pr: 1, head: "first", policyAvailable: true, surfaceIds: [], automations: [{ id: "reviewer", terminal: true }], unresolvedThreads: 0, unansweredAutomationThreads: 0 },
      { pr: 2, head: "top", policyAvailable: true, surfaceIds: ["human-review", "human-comment"], automations: [{ id: "reviewer", terminal: false }], unresolvedThreads: 2, unansweredAutomationThreads: 1 },
    ] },
    live: input().live,
    packets: [
      { identity: { repo: "frostney/test", pr: 1, head: "first" }, observation: { head: "first", policyAvailable: true, findingSurfaces: [], automations: [{ id: "reviewer", terminal: true }], unresolvedThreads: 0, unansweredAutomationThreads: 0 } },
      { identity: { repo: "frostney/test", pr: 2, head: "top" }, observation: { head: "top", policyAvailable: true, findingSurfaces: [{ id: "human-comment" }, { id: "human-review" }], automations: [{ id: "reviewer", terminal: false }], unresolvedThreads: 2, unansweredAutomationThreads: 1 } },
    ],
  });
  const grade = (x: ReturnType<typeof make>) => gradeFeedbackCensus(x.assessment, x.live, x.packets);
  expect(grade(make())).toBe(true);
  const reordered = make();
  reordered.assessment.feedback[1]!.automations = [{ terminal: false, id: "reviewer" }];
  expect(grade(reordered)).toBe(true);
  for (const mutate of [
    (x: any) => x.assessment.feedback.pop(),
    (x: any) => x.assessment.feedback[1].surfaceIds.pop(),
    (x: any) => x.assessment.feedback[1].surfaceIds.push("fabricated"),
    (x: any) => x.assessment.feedback[1].surfaceIds.push("human-review"),
    (x: any) => (x.assessment.feedback[1].policyAvailable = false),
    (x: any) => (x.assessment.feedback[1].automations[0].terminal = true),
    (x: any) => (x.assessment.feedback[1].unresolvedThreads = 0),
    (x: any) => (x.assessment.feedback[1].unansweredAutomationThreads = 0),
    (x: any) => (x.assessment.feedback[1].automations = []),
    (x: any) => (x.packets[1].observation.head = "stale"),
    (x: any) => (x.packets[1].identity.repo = "another/repo"),
    (x: any) => (x.packets[1].identity.head = "stale"),
    (x: any) => x.packets.reverse(),
    (x: any) => (x.live.observation.members[1].head = "advanced"),
  ]) {
    const x = make(); mutate(x); expect(grade(x)).toBe(false);
  }
  const unknown: any = make();
  for (let i = 0; i < 2; i++) {
    for (const row of [unknown.assessment.feedback[i], unknown.packets[i].observation]) {
      row.policyAvailable = false;
      row.automations = [];
      row.unansweredAutomationThreads = null;
    }
  }
  expect(grade(unknown)).toBe(true);
  unknown.assessment.feedback[1].unansweredAutomationThreads = 0;
  expect(grade(unknown)).toBe(false);
});
