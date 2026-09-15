import { expect, test } from "bun:test";
import { validateTarget } from "./github-live.ts";
import { gradeRun } from "./grading.ts";
import type { RunLedger, EvalCase } from "./types.ts";
const empty = (): RunLedger => ({
  actions: [],
  events: [],
  inspections: ["code", "docs"],
  loadedSkills: [],
  loadedReferences: [],
  registeredSkillCalls: [],
});
const scenario: EvalCase = {
  id: "packet",
  description: "",
  prompt: "",
  fixture: { evidence: { code: "Current behavior", docs: "Source contract" } },
  expected: {
    decisionPacket: true,
    requiredActionSequence: ["report", "user.ask"],
  },
};
const packet = () => ({
  current: [{ source: "code", fact: "Current observed behavior" }],
  options: [
    {
      id: "a",
      benefit: "Preserves compatibility",
      cost: "One conditional",
      uncertainty: "Legacy support",
      sources: ["code", "docs"],
    },
    {
      id: "b",
      benefit: "Removes deprecated path",
      cost: "Drops older browser support",
      uncertainty: "Usage unknown",
      sources: ["docs"],
    },
  ],
  recommendationId: "a",
});
const ledger = (value: unknown) => {
  const l = empty();
  l.actions = [
    {
      action: "report",
      details: "Comparison",
      data: { decisionPacket: value },
    },
    { action: "user.ask", details: "Choose a or b" },
  ];
  l.events = [
    { kind: "action", name: "report" },
    { kind: "action", name: "user.ask" },
  ];
  return l;
};
test("comparison evidence requires inspected sources, distinct options and a real recommendation", () => {
  expect(gradeRun(scenario, ledger(packet()), "Choose").passed).toBe(true);
  for (const mutate of [
    (p: any) => (p.current[0].source = "invented"),
    (p: any) => (p.options[1].id = "a"),
    (p: any) => (p.options[0].cost = ""),
    (p: any) => (p.recommendationId = "absent"),
    (p: any) => (p.options[1].sources = []),
  ]) {
    const p = packet();
    mutate(p);
    expect(gradeRun(scenario, ledger(p), "Choose").passed).toBe(false);
  }
  const l = ledger(packet());
  l.inspections = [];
  expect(gradeRun(scenario, l, "Choose").passed).toBe(false);
  const late = ledger(packet());
  late.events.reverse();
  expect(gradeRun(scenario, late, "Choose").passed).toBe(false);
  expect(gradeRun(scenario, empty(), JSON.stringify(packet())).passed).toBe(
    false,
  );
});
test("live GitHub target requires disposable frostney identity and a bounded branch", () => {
  const c = {
    repository: "frostney/kgr-eval-20260905-test",
    repositoryId: 123,
    branch: "codex/eval-astra",
    base: "a".repeat(40),
    directory: "/tmp/x",
    evidence: "/tmp/e",
    model: "codex:gpt-6-astra",
    skillsRoot: "/tmp/s",
    research: {
      query: "q",
      searchedAt: "2026-09-05",
      url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/trim",
      summary: "trim removes whitespace",
    },
  };
  expect(() => validateTarget(c)).not.toThrow();
  for (const patch of [
    { repository: "frostney/known-good-route" },
    { repository: "someone/kgr-eval-20260905-test" },
    { repositoryId: 0 },
    { branch: "main" },
    { branch: "codex/eval-x;bad" },
    { base: "HEAD" },
  ])
    expect(() => validateTarget({ ...c, ...patch })).toThrow();
});

test("administrative delegation cannot admit an implementation worker through the prerequisite exception", () => {
  const c: EvalCase = {
    ...scenario,
    expected: { allowedDelegateWorkflows: ["/create-issue automatic"] },
  };
  const l = empty();
  expect(gradeRun(c, l, "blocked").passed).toBe(true);
  l.actions.push({
    action: "delegate",
    details: "Prerequisite filing only",
    data: { workflow: "/create-issue automatic" },
  });
  expect(gradeRun(c, l, "blocked").passed).toBe(true);
  l.actions.push({
    action: "delegate",
    details: "Start implementation",
    data: { workflow: "/implement automatic" },
  });
  expect(gradeRun(c, l, "blocked").passed).toBe(false);
});
test("live GitHub execution is refused in CI before inventory or authentication is read", async () => {
  const p = Bun.spawn(
    [
      process.execPath,
      new URL("./github-live-run.ts", import.meta.url).pathname,
      "--execute",
    ],
    { env: { ...process.env, CI: "true" }, stdout: "pipe", stderr: "pipe" },
  );
  const stderr = await new Response(p.stderr).text();
  expect(await p.exited).not.toBe(0);
  expect(stderr).toContain("explicit local --execute");
});
