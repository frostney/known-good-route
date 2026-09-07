import { describe, expect, test } from "bun:test";
import { gradeRun } from "./grading.ts";
import { promptingCases } from "./prompting-cases.ts";
import type { RunLedger } from "./types.ts";
const empty = (): RunLedger => ({
  actions: [],
  loadedSkills: [],
  loadedReferences: [],
  registeredSkillCalls: [],
  inspections: [],
  events: [],
});

describe("prompting regression evidence", () => {
  test("settled work fails on a new interview or repeated aggregate gates", () => {
    const scenario = promptingCases.find(
      (c) => c.id === "prompting-settled-implementation",
    )!;
    const ledger: RunLedger = {
      ...empty(),
      loadedSkills: ["implement"],
      inspections: [
        "context",
        "currentIssue",
        "currentWebResearch",
        "projectGate",
      ],
      actions: [
        { action: "file.edit", details: "Applied approved null guard" },
      ],
    };
    expect(
      gradeRun(scenario, ledger, "Implemented and validated").passed,
    ).toBeTrue();
    expect(
      gradeRun(
        scenario,
        {
          ...ledger,
          actions: [
            ...ledger.actions,
            { action: "user.ask", details: "Choose among new options" },
          ],
        },
        "Choose a design",
      ).passed,
    ).toBeFalse();
    expect(
      gradeRun(
        scenario,
        {
          ...ledger,
          actions: [
            ...ledger.actions,
            { action: "validation.run", details: "Full gate" },
            { action: "validation.run", details: "Same full gate" },
          ],
        },
        "Done",
      ).passed,
    ).toBeFalse();
  });
  test("a simulated delegation cannot substitute for native worker evidence", () => {
    const scenario = promptingCases.find(
      (c) => c.id === "prompting-native-worker-delivery",
    )!;
    const parent: RunLedger = {
      ...empty(),
      loadedSkills: ["software-engineering-excellence"],
      actions: [{ action: "delegate", details: "Claimed worker result" }],
    };
    expect(gradeRun(scenario, parent, "PR #622 ready").passed).toBeFalse();
    const workerCase = promptingCases.find(
      (c) => c.id === "prompting-native-worker-pr",
    )!;
    const workerLedger: RunLedger = {
      ...empty(),
      loadedSkills: ["address-feedback"],
      loadedReferences: [
        "address-feedback/references/pr.md",
        "address-feedback/references/pr-readiness.md",
      ],
      inspections: ["pullRequest"],
    };
    const worker = {
      model: "claude:claude-opus-5",
      caseId: workerCase.id,
      mode: "process" as const,
      instructions: "The isolated worker's delivered harness instructions.",
      responseModels: ["claude-opus-5"],
      observedModels: ["claude-opus-5"],
      version: "test",
      context: "Read-only PR #622",
      transcript: "/tmp/test-transcript",
      ledger: workerLedger,
      grade: gradeRun(workerCase, workerLedger, "PR #622 ready"),
      output: "PR #622 ready",
    };
    expect(
      gradeRun(scenario, { ...parent, workers: [worker] }, worker.output)
        .passed,
    ).toBeTrue();
    // Initialization/configured-model labels are not response identity. A valid
    // response remains valid even when ancillary initialization labels differ.
    expect(gradeRun(scenario,{...parent,workers:[{...worker,observedModels:["configured-alias"]}]},worker.output).passed).toBeTrue();
    const { responseModels: _responses, ...withoutResponseMetadata } = worker;
    for (const bad of [
      withoutResponseMetadata,
      { ...worker, responseModels: [] },
      { ...worker, responseModels: ["claude-haiku-4-5-20251001"] },
      { ...worker, responseModels: ["claude-opus-5", "claude-haiku-4-5-20251001"] },
      { ...worker, caseId: "another-worker-task" },
      { ...worker, mode: "claude-agent" as const },
      { ...worker, context: " " },
      { ...worker, instructions: " " },
      { ...worker, output: " " },
      { ...worker, grade: { passed: true, checks: [{ name: "missing gate", passed: false, detail: "not observed" }] } },
      { ...worker, ledger: { ...workerLedger, workers: [worker] } },
      { ...worker, error: "login required" },
      {
        ...worker,
        grade: gradeRun(
          workerCase,
          { ...workerLedger, loadedReferences: [] },
          worker.output,
        ),
      },
      {
        ...worker,
        grade: gradeRun(
          workerCase,
          {
            ...workerLedger,
            actions: [{ action: "file.edit", details: "unauthorized edit" }],
          },
          worker.output,
        ),
      },
    ])
      expect(
        gradeRun(scenario, { ...parent, workers: [bad] }, worker.output).passed,
      ).toBeFalse();
  });
});
