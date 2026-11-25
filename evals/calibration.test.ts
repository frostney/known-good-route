import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gradeRun, validateCases } from "./grading.ts";
import { createEvalTools } from "./tools.ts";
import type { ActionName, ActionSelector, EvalCase, RunLedger } from "./types.ts";
import { evalCases } from "./cases.ts";
test("synthetic full revisions are valid SHA-1 lengths and do not override concrete case revisions", () => {
  for (const c of evalCases) {
    const evidence = JSON.stringify(c.fixture);
    for (const match of evidence.matchAll(/\b[0-9a-f]{41,}\b/g))
      throw new Error(`${c.id}: malformed synthetic full revision ${match[0]}`);
    expect(evidence).not.toContain("unless another concrete revision");
  }
});
// A model copying an id that repeats one unit can lose count of it: one model
// wrote such ids two characters short and failed exact-value rules (issue #179).
const repeats = (id: string) => /(.)\1{7}/.test(id)
  || Array.from({ length: 20 }, (_, i) => i + 1).some((period) => [...id].every((ch, i) => i + period >= id.length || ch === id[i + period]));
test("no case shows a full commit id that repeats a unit or holds a long run of one character", () => {
  for (const id of ["2b".repeat(20), "1".repeat(40), `51ca1ab${"1".repeat(33)}`, "0123456789abcdef0123456789abcdef01234567"])
    expect(repeats(id)).toBeTrue();
  expect(repeats("2b2b2b2e5bc80dc07eed8e08881fd447edf43bb8")).toBeFalse();
  for (const c of evalCases)
    for (const [id] of JSON.stringify(c).matchAll(/\b[0-9a-f]{40}\b/g))
      if (repeats(id)) throw new Error(`${c.id}: commit id ${id} repeats; give the fixture an id with no pattern`);
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
  fixture: { environment: { orchestration: { endpoint: "deployed", entryPoints: "stop" } }, evidence: {} },
  expected: {
    rubric: [{ id: "outcome", question: "Does the answer report the outcome?" }],
    ...expected,
  },
});
test("preflight rejects impossible calibration and worker setups before native calls", () => {
  expect(() =>
    validateCases(
      [scenario({ reportPatterns: ["["] } as EvalCase["expected"])],
      new Set(),
    ),
  ).toThrow("was removed");
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
  c.expected.forbiddenWorker = true;
  expect(() => validateCases([c], new Set(), [c, child])).not.toThrow();
  c.expected.requiredWorker = true;
  expect(() => validateCases([c], new Set(), [c, child])).toThrow("forbidden worker");
  c.expected.requiredWorker = false;
  c.worker = { ...c.worker!, mode: "claude-agent" };
  expect(() => validateCases([c], new Set(), [c, child])).toThrow("forbidden worker");
  c.worker = { model: "claude:claude-opus-5", caseId: "missing" };
  c.expected.requiredWorker = true;
  const { worker: _worker, ...unconfigured } = c;
  expect(() => validateCases([{ ...unconfigured, expected: { ...c.expected, requiredWorker: false } }], new Set())).toThrow("forbidden worker");
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
    scenario({ discoverySkills: ["deep-dive"] }),
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

test("a new action name moves no case hash", async () => {
  // Case modules are loaded in a fresh process after actionNames gains a
  // forge action and an action in a new namespace, so a case that derives its
  // content from the inventory, by namespace or by exclusion, changes hash.
  const manifest = await Bun.file(new URL("./calibration.json", import.meta.url)).json();
  const directory = await mkdtemp(join(tmpdir(), "kgr-action-names-"));
  try {
    const script = join(directory, "hashes.ts");
    await Bun.write(script, [
      `import { createHash } from "node:crypto";`,
      `import { actionNames } from ${JSON.stringify(new URL("./types.ts", import.meta.url).href)};`,
      `(actionNames as unknown as string[]).push("forge.calibrationProbe", "probe.calibration");`,
      `const { evalCases } = await import(${JSON.stringify(new URL("./cases.ts", import.meta.url).href)});`,
      `console.log(JSON.stringify(Object.fromEntries(evalCases.map((c: { id: string }) => [c.id, createHash("sha256").update(JSON.stringify(c)).digest("hex")]))));`,
    ].join("\n"));
    const run = Bun.spawnSync([process.execPath, script], { stderr: "pipe" });
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    const hashes: Record<string, string> = JSON.parse(run.stdout.toString());
    expect(Object.keys(hashes)).toHaveLength(evalCases.length);
    for (const entry of manifest.cases as Array<{ caseId: string; afterSha256: string }>)
      expect(`${entry.caseId} ${hashes[entry.caseId]}`).toBe(`${entry.caseId} ${entry.afterSha256}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("a namespace selector forbids every action in its namespace, and permittedActions every action it omits", () => {
  const graded = (expected: EvalCase["expected"], action: ActionName) => {
    const ledger = empty();
    ledger.actions.push({ action, details: action });
    ledger.events.push({ kind: "action", name: action });
    return gradeRun(scenario(expected), ledger, "Done").passed;
  };
  expect(graded({ forbiddenActions: ["forge.*"] }, "forge.createIssue")).toBe(false);
  expect(graded({ forbiddenActions: ["forge.*"] }, "git.commit")).toBe(true);
  expect(graded({ permittedActions: ["report", "validation.run"] }, "validation.run")).toBe(true);
  expect(graded({ permittedActions: ["report", "validation.run"] }, "file.edit")).toBe(false);
  expect(graded({ permittedActions: ["report", "file.edit"], forbiddenActions: ["file.edit"] }, "file.edit")).toBe(false);
});
test("preflight rejects a selector that matches nothing and a requirement on a forbidden action", () => {
  expect(() => validateCases([scenario({ forbiddenActions: ["no-such-namespace.*" as ActionSelector] })], new Set())).toThrow("matches no action");
  for (const expected of [
    { permittedActions: ["report"], requiredActions: ["file.edit"] },
    { permittedActions: ["report"], requiredActionSequence: ["report", "file.edit"] },
    { permittedActions: ["report"], minActionCounts: { "file.edit": 1 } },
    { forbiddenActions: ["forge.*"], requiredActionSequence: ["forge.openDraftPr"] },
  ] as Array<EvalCase["expected"]>)
    expect(() => validateCases([scenario(expected)], new Set())).toThrow("requires and forbids");
  // An alternative list needs one permitted action, not all of them.
  expect(() => validateCases([scenario({ permittedActions: ["report", "validation.run"], requiredAnyActions: ["validation.run", "validation.reuse"] })], new Set())).not.toThrow();
  expect(() => validateCases([scenario({ permittedActions: ["report"], requiredAnyActions: ["validation.run", "validation.reuse"] })], new Set())).toThrow("accepts only forbidden actions");
  expect(() => validateCases([scenario({ permittedActions: ["report"], minActionCounts: { "file.edit": 0 } })], new Set())).not.toThrow();
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
