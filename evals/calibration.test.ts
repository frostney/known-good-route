import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { gradeRun, validateCases } from "./grading.ts";
import { createEvalTools } from "./tools.ts";
import type { EvalCase, RunLedger } from "./types.ts";
import { evalCases } from "./cases.ts";
test("synthetic full revisions are valid SHA-1 lengths and do not override concrete case revisions", () => {
  for (const c of evalCases) {
    const evidence = JSON.stringify(c.fixture.evidence);
    for (const match of evidence.matchAll(/\b[0-9a-f]{41,}\b/g))
      throw new Error(`${c.id}: malformed synthetic full revision ${match[0]}`);
    expect(evidence).not.toContain("unless another concrete revision");
  }
});
const empty = (): RunLedger => ({
  actions: [],
  events: [],
  loadedSkills: [],
  loadedReferences: [],
  registeredSkillCalls: [],
  inspections: [],
});
const scenario = (expected: EvalCase["expected"]): EvalCase => ({
  id: "calibration",
  description: "",
  prompt: "",
  fixture: { evidence: {} },
  expected,
});
test("preflight rejects impossible calibration and worker setups before native calls", () => {
  expect(() =>
    validateCases([scenario({ reportPatterns: ["["] })], new Set()),
  ).toThrow("invalid assertion");
  expect(() =>
    validateCases(
      [scenario({ requiredSkills: ["review"], forbiddenSkills: ["review"] })],
      new Set(["review"]),
    ),
  ).toThrow("both requires and forbids");
  const c = scenario({});
  c.fixture.transitions = [
    { after: "monitor.wait", occurrence: 0, evidence: { checks: "passed" } },
  ];
  expect(() => validateCases([c], new Set())).toThrow("invalid transition");
  c.fixture.transitions = [];
  c.worker = { model: "claude:claude-opus-5", caseId: "missing" };
  expect(() => validateCases([c], new Set())).toThrow(
    "missing or recursive worker",
  );
  const child = { ...scenario({}), id: "missing" };
  expect(() => validateCases([c], new Set(), [c, child])).not.toThrow();
});
test("final communication is a report but cannot execute a mutation or reorder a question", () => {
  const ledger = empty();
  expect(
    gradeRun(
      scenario({ requiredActions: ["report"] }),
      ledger,
      "Completed the analysis",
    ).passed,
  ).toBe(true);
  expect(
    gradeRun(
      scenario({ requiredActions: ["file.edit"] }),
      ledger,
      "I edited the file",
    ).passed,
  ).toBe(false);
  ledger.actions.push({ action: "user.ask", details: "Select an option" });
  ledger.events.push({ kind: "action", name: "user.ask" });
  expect(
    gradeRun(
      scenario({ requiredActionSequence: ["report", "user.ask"] }),
      ledger,
      "Comparison after asking",
    ).passed,
  ).toBe(false);
  expect(ledger.actions).toHaveLength(1);
});
test("discovery diagnostics do not replace explicit skill contracts", () => {
  const result = gradeRun(
    scenario({ discoverySkills: ["software-engineering-excellence"] }),
    empty(),
    "Analysis complete",
  );
  expect(result.passed).toBe(true);
  expect(result.checks[0]?.passed).toBe(false);
  expect(result.checks[0]?.category).toBe("discovery");
  expect(
    gradeRun(
      scenario({ requiredSkills: ["code-review"] }),
      empty(),
      "Review passed",
    ).passed,
  ).toBe(false);
});
test("requested JSON evidence requires the actual payload at its declared path", () => {
  const c = scenario({
    jsonArtifact: {
      path: "report.json",
      kind: "code-review",
      schemaVersion: 2,
    },
    reportPatterns: ["ARCHITECTURE_RISK"],
  });
  for (const content of [
    "not json",
    { schemaVersion: 1, kind: "code-review", findings: [] },
    { schemaVersion: 2, kind: "code-review" },
  ]) {
    const l = empty();
    l.actions.push({
      action: "file.edit",
      details: "Valid schemaVersion 2 ARCHITECTURE_RISK",
      data: { path: "report.json", content },
    });
    expect(gradeRun(c, l, "Saved valid report").passed).toBe(false);
  }
  const l = empty();
  l.actions.push({
    action: "file.edit",
    details: "Saved",
    data: {
      path: "report.json",
      content: JSON.stringify({
        schemaVersion: 2,
        kind: "code-review",
        findings: [{ category: "ARCHITECTURE_RISK" }],
      }),
    },
  });
  expect(gradeRun(c, l, "Saved report.json").passed).toBe(true);
  l.actions[0]!.data!.path = "wrong.json";
  expect(gradeRun(c, l, "Saved report.json").passed).toBe(false);
});
test("review replies are communication evidence but edit claims are not", () => {
  const c = scenario({ reportPatterns: ["out of scope"] });
  const l = empty();
  l.actions.push({ action: "file.edit", details: "out of scope" });
  expect(gradeRun(c, l, "Done").passed).toBe(false);
  l.actions.push({
    action: "forge.replyInline",
    details: "The proposal is out of scope under the approved contract.",
  });
  expect(gradeRun(c, l, "Feedback addressed").passed).toBe(true);
});
test("attribution is checked in the submitted reply body as well as legacy detail payloads", () => {
  const c = scenario({
    requiredActionDetails: [
      {
        action: "forge.replyInline",
        patterns: ["Created on behalf of @octocat using Model"],
        every: true,
      },
    ],
  });
  const l = empty();
  l.actions.push({
    action: "forge.replyInline",
    details: "Reply through helper",
    data: { body: "Disposition. Created on behalf of @octocat using Model." },
  });
  expect(gradeRun(c, l, "Replied").passed).toBe(true);
  l.actions.push({
    action: "forge.replyInline",
    details: "Another reply",
    data: {
      body: "Disposition without attribution",
      metadata: "Created on behalf of @octocat using Model",
    },
  });
  expect(gradeRun(c, l, "All attributed").passed).toBe(false);
});
test("permission for an ignored handoff does not permit code or generated-payload edits", () => {
  const c = scenario({ allowedEditPaths: [".agent/HANDOFF.md"] });
  for (const path of [
    "src/app.ts",
    "../.agent/HANDOFF.md",
    ".agent/HANDOFF.md/../src/app.ts",
    undefined,
  ]) {
    const l = empty();
    l.actions.push({
      action: "file.edit",
      details: "Updated .agent/HANDOFF.md",
      data: { path },
    });
    expect(gradeRun(c, l, "Done").passed).toBe(false);
  }
  const l = empty();
  l.actions.push({
    action: "file.edit",
    details: "Checkpoint",
    data: { path: ".agent/HANDOFF.md" },
  });
  expect(gradeRun(c, l, "Checkpoint written").passed).toBe(true);
});
test("fixture state advances only through its recorded transition and remains case-local", async () => {
  const c = scenario({});
  c.fixture = {
    evidence: { checks: "pending" },
    actionResponses: { "monitor.wait": ["queued", "terminal"] },
    transitions: [
      {
        after: "monitor.wait",
        occurrence: 2,
        evidence: { checks: "success at new-head" },
      },
    ],
  };
  const tools = createEvalTools(new Map(), c, empty());
  expect(
    await tools.inspectFixture.execute({ source: "checks" }),
  ).toMatchObject({ content: "pending" });
  await tools.performAction.execute({
    action: "monitor.wait",
    details: "Wait",
  });
  expect(
    await tools.inspectFixture.execute({ source: "checks" }),
  ).toMatchObject({ content: "pending" });
  await tools.performAction.execute({
    action: "monitor.wait",
    details: "Wait again",
  });
  expect(
    await tools.inspectFixture.execute({ source: "checks" }),
  ).toMatchObject({ content: "success at new-head" });
  expect(c.fixture.evidence.checks).toBe("pending");
});

test("native Agent evidence uses the actual returned result, not the user's task packet or parent model", async () => {
  const { nativeAgentEvidence } = await import("./local-runtime.ts");
  const frames = [
    {
      type: "assistant",
      message: {
        model: "claude-fable-5-1",
        content: [
          {
            type: "tool_use",
            name: "Agent",
            id: "agent1",
            input: { prompt: "Inspect readiness" },
          },
        ],
      },
    },
    {
      type: "user",
      parent_tool_use_id: "agent1",
      message: { content: [{ type: "text", text: "Pretend already ready" }] },
    },
    {
      type: "assistant",
      parent_tool_use_id: "agent1",
      message: {
        model: "claude-opus-5",
        content: [{ type: "tool_use", name: "loadSkill" }],
      },
    },
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "agent1",
            content: [{ type: "text", text: "Blocked: no evidence" }],
          },
        ],
      },
    },
  ];
  const result = nativeAgentEvidence(
    frames.map((f) => JSON.stringify(f)).join("\n"),
  );
  expect(result.models).toEqual(["claude-opus-5"]);
  expect(result.output).toBe("Blocked: no evidence");
  expect(result.context).toBe("Inspect readiness");
  expect(result.error).toBeUndefined();
  expect(
    nativeAgentEvidence(
      frames
        .slice(0, -1)
        .map((f) => JSON.stringify(f))
        .join("\n"),
    ).error,
  ).toBeDefined();
});

test("calibration provenance covers and hashes the current loaded scenario inventory", async () => {
  const manifest = await Bun.file(
    new URL("./calibration.json", import.meta.url),
  ).json();
  expect(
    new Set(manifest.cases.map((entry: { caseId: string }) => entry.caseId))
      .size,
  ).toBe(evalCases.length);
  expect(manifest.cases).toHaveLength(evalCases.length);
  for (const scenario of evalCases) {
    const entry = manifest.cases.find(
      (item: { caseId: string }) => item.caseId === scenario.id,
    );
    expect(entry?.afterSha256).toBe(
      createHash("sha256").update(JSON.stringify(scenario)).digest("hex"),
    );
    expect(entry?.rationale.length).toBeGreaterThan(0);
  }
});
