import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evalCases } from "./cases.ts";
import { validateCases, validateRubric } from "./grading.ts";
import {
  aggregateRepeats,
  calibrationDigest,
  calibrationGate,
  combineJudgement,
  judgeAnswer,
  judgeInput,
  judgesFromFlags,
  loadJudgeCalibration,
  parseJudgeOutput,
  renderAnswer,
  rowOutcome,
  sampleAgrees,
  scoreCalibration,
  selectJudge,
  validateCalibrationSamples,
  withJudgement,
  type CalibrationSample,
  type JudgeCalibration,
  type JudgeRunner,
  type RubricVerdict,
} from "./judge.ts";
import { judgeRecord, parseCli } from "./run.ts";
import type { EvalCase, EvalRunRecord, RubricItem, RunLedger } from "./types.ts";

const rubric: RubricItem[] = [
  { id: "blocked", question: "Does the answer report that PR #7 is blocked by the failing check?" },
  { id: "head", question: "Does the answer name head revision abc1234?" },
];
const answer = renderAnswer("PR #7 is blocked: lint failed at head abc1234.", [
  { action: "forge.commentPr", details: "Status note", data: { body: "Blocked on lint.\nNext: fix lint.", pr: 7 } },
]);
const verdicts = (items: Array<{ id: string; verdict: "yes" | "no"; quote: string }>) =>
  JSON.stringify({ items });
const emptyLedger = (): RunLedger => ({
  actions: [], events: [], loadedSkills: [], loadedReferences: [], registeredSkillCalls: [], inspections: [],
});

describe("judge parsing", () => {
  test("the answer lists the final response and every action with raw data fields", () => {
    expect(answer).toContain("Final response:\nPR #7 is blocked");
    expect(answer).toContain("[1] forge.commentPr\ndetails: Status note");
    expect(answer).toContain("data.body: Blocked on lint.\nNext: fix lint.");
    expect(answer).toContain("data.pr: 7");
    expect(JSON.parse(judgeInput("Task", rubric, answer))).toEqual({ task: "Task", rubric, answer });
  });
  test("every rubric item gets exactly one verdict in rubric order", () => {
    const parsed = parseJudgeOutput(
      verdicts([
        { id: "head", verdict: "yes", quote: "head abc1234" },
        { id: "blocked", verdict: "yes", quote: "PR #7 is blocked" },
      ]),
      rubric,
      answer,
    );
    expect(parsed.map((v) => [v.id, v.passed])).toEqual([["blocked", true], ["head", true]]);
  });
  test("malformed, missing, unknown or repeated verdicts are judge errors, not grades", () => {
    for (const raw of [
      "not json",
      JSON.stringify({ items: [{ id: "blocked", verdict: "maybe", quote: "" }] }),
      JSON.stringify({ items: [], extra: true }),
      verdicts([{ id: "blocked", verdict: "yes", quote: "PR #7 is blocked" }]),
      verdicts([
        { id: "blocked", verdict: "yes", quote: "PR #7 is blocked" },
        { id: "head", verdict: "yes", quote: "abc1234" },
        { id: "other", verdict: "yes", quote: "abc1234" },
      ]),
      verdicts([
        { id: "blocked", verdict: "yes", quote: "PR #7 is blocked" },
        { id: "blocked", verdict: "no", quote: "" },
        { id: "head", verdict: "yes", quote: "abc1234" },
      ]),
    ])
      expect(() => parseJudgeOutput(raw, rubric, answer)).toThrow();
  });
});

describe("quote enforcement", () => {
  const judge = (quote: string, verdict: "yes" | "no" = "yes") =>
    parseJudgeOutput(
      verdicts([
        { id: "blocked", verdict, quote },
        { id: "head", verdict: "yes", quote: "abc1234" },
      ]),
      rubric,
      answer,
    )[0]!;
  test("a yes needs a quote that is in the answer", () => {
    expect(judge("PR #7 is blocked").passed).toBeTrue();
    // Whitespace differences across a line break are tolerated; words are not.
    expect(judge("Blocked on lint. Next: fix lint.").passed).toBeTrue();
    expect(judge("").passed).toBeFalse();
    expect(judge("   ").passed).toBeFalse();
    expect(judge("PR #7 is ready").passed).toBeFalse();
    expect(judge("PR #7 is blocked … abc1234").quoteFound).toBeFalse();
  });
  test("a no fails the item whatever it quotes", () => {
    expect(judge("PR #7 is blocked", "no").passed).toBeFalse();
    expect(judge("", "no").passed).toBeFalse();
  });
  test("a judge cannot quote the task instead of the answer", () => {
    const parsed = parseJudgeOutput(
      verdicts([
        { id: "blocked", verdict: "yes", quote: "Report the PR state" },
        { id: "head", verdict: "yes", quote: "abc1234" },
      ]),
      rubric,
      answer,
    );
    expect(parsed[0]!.passed).toBeFalse();
  });
});

describe("cross-family judge choice", () => {
  test("Claude judges Codex runs and Codex judges Claude runs by default", () => {
    expect(selectJudge("codex:gpt-6-astra")).toEqual({ judge: "claude:claude-opus-5-5", crossFamily: true });
    expect(selectJudge("claude:claude-fable-5-1")).toEqual({ judge: "codex:gpt-6-sol", crossFamily: true });
  });
  test("the judge model is configurable per family", () => {
    const judges = judgesFromFlags(["claude:claude-fable-5-1", "codex:gpt-6-astra"]);
    expect(selectJudge("codex:gpt-6-sol", judges).judge).toBe("claude:claude-fable-5-1");
    expect(selectJudge("claude:claude-opus-5-5", judges).judge).toBe("codex:gpt-6-astra");
    expect(() => judgesFromFlags(["codex:a", "codex:b"])).toThrow("at most one");
    expect(() => selectJudge("codex:a", { codex: "codex:b", claude: "codex:c" })).toThrow("claude model");
    expect(parseCli(["--judge", "codex:gpt-6-astra"]).judges).toEqual({
      codex: "codex:gpt-6-astra",
      claude: "claude:claude-opus-5-5",
    });
  });
  test("a same-family judge is explicit and never trusted", () => {
    const selection = selectJudge("codex:gpt-6-astra", judgesFromFlags(["codex:gpt-6-sol"]), true);
    expect(selection).toEqual({ judge: "codex:gpt-6-sol", crossFamily: false });
    expect(parseCli(["--same-family-judge"]).sameFamilyJudge).toBeTrue();
    const judgement = combineJudgement(selection, { calibrated: true, reason: "ok" }, []);
    expect(judgement.trusted).toBeFalse();
  });
});

const sample = (label: "pass" | "fail", failingItems?: string[]): CalibrationSample => ({
  caseId: "c", output: "x", label, source: "test", ...(failingItems ? { failingItems } : {}),
});
const verdict = (id: string, passed: boolean): RubricVerdict => ({
  id, question: "?", verdict: passed ? "yes" : "no", quote: passed ? "x" : "", quoteFound: passed, passed,
});

describe("calibration gate", () => {
  test("agreement follows the human label, including which item fails", () => {
    expect(sampleAgrees(sample("pass"), [verdict("a", true), verdict("b", true)])).toBeTrue();
    expect(sampleAgrees(sample("pass"), [verdict("a", true), verdict("b", false)])).toBeFalse();
    expect(sampleAgrees(sample("fail", ["b"]), [verdict("a", true), verdict("b", false)])).toBeTrue();
    expect(sampleAgrees(sample("fail", ["b"]), [verdict("a", false), verdict("b", true)])).toBeFalse();
    expect(sampleAgrees(sample("pass"), undefined)).toBeFalse();
  });
  const calibration = (results: JudgeCalibration["results"]): JudgeCalibration => ({
    agreementThreshold: 0.9, minimumSamples: 10, samples: [], results,
  });
  const scored = (agreeing: number, total: number, falsePass = false) => {
    const samples = Array.from({ length: total }, (_, i) => sample(i === 0 && falsePass ? "fail" : "pass", i === 0 && falsePass ? ["a"] : undefined));
    const judged = samples.map((_, i) => [verdict("a", i < agreeing || (i === 0 && falsePass))]);
    return scoreCalibration(samples, judged, "digest", "2026-10-01T00:00:00Z");
  };
  test("the gate opens only for a current, sufficient, accurate calibration", () => {
    expect(calibrationGate("codex:j", calibration({}), "digest").calibrated).toBeFalse();
    const good = scored(10, 10);
    expect(good).toMatchObject({ agreed: 10, total: 10, agreement: 1, falsePasses: 0 });
    expect(calibrationGate("codex:j", calibration({ "codex:j": good }), "digest").calibrated).toBeTrue();
    expect(calibrationGate("codex:j", calibration({ "codex:j": good }), "changed").reason).toContain("predates");
    expect(calibrationGate("codex:other", calibration({ "codex:j": good }), "digest").calibrated).toBeFalse();
    const few = scored(9, 9);
    expect(calibrationGate("codex:j", calibration({ "codex:j": few }), "digest").reason).toContain("required samples");
    const low = scored(8, 10);
    expect(calibrationGate("codex:j", calibration({ "codex:j": low }), "digest").reason).toContain("below 0.9");
    const lenient = scored(10, 10, true);
    expect(lenient.falsePasses).toBe(1);
    expect(lenient.agreement).toBe(0.9);
    expect(calibrationGate("codex:j", calibration({ "codex:j": lenient }), "digest").reason).toContain("judged as passing");
  });
  test("the digest covers samples, their rubrics and the judge protocol", () => {
    const c = { id: "c", description: "", prompt: "", fixture: { evidence: {} }, expected: { rubric } } as EvalCase;
    const base = calibrationDigest([sample("pass")], [c]);
    expect(calibrationDigest([sample("fail", ["head"])], [c])).not.toBe(base);
    expect(calibrationDigest([sample("pass")], [{ ...c, expected: { rubric: rubric.slice(1) } }])).not.toBe(base);
  });
  test("an uncalibrated judge's failure needs human review instead of failing", () => {
    const grade = { passed: true, checks: [{ name: "required actions", passed: true, detail: "" }] };
    const failed = { scope: "parent", status: "fail" as const, items: [verdict("a", false)] };
    const untrusted = combineJudgement({ judge: "claude:j", crossFamily: true }, { calibrated: false, reason: "none" }, [failed]);
    const trusted = combineJudgement({ judge: "claude:j", crossFamily: true }, { calibrated: true, reason: "ok" }, [failed]);
    const record = (judgement: typeof trusted) => ({ grade: withJudgement(grade, judgement), judgement });
    expect(rowOutcome(record(untrusted))).toBe("review");
    expect(rowOutcome(record(trusted))).toBe("fail");
    // Deterministic failures stay failures whatever the judge says.
    const broken = { passed: false, checks: [{ name: "forbidden actions", passed: false, detail: "" }] };
    expect(rowOutcome({ grade: withJudgement(broken, untrusted), judgement: untrusted })).toBe("fail");
    const errored = combineJudgement({ judge: "claude:j", crossFamily: true }, { calibrated: true, reason: "ok" }, [
      { scope: "parent", status: "error", items: [], error: "unavailable" },
    ]);
    expect(rowOutcome({ grade: withJudgement(grade, errored), judgement: errored })).toBe("error");
    expect(rowOutcome({ grade: withJudgement(grade, undefined) })).toBe("error");
  });
  test("the committed calibration samples are well formed and the gate reads them", async () => {
    const committed = await loadJudgeCalibration();
    validateCalibrationSamples(committed, evalCases);
    expect(committed.samples.length).toBeGreaterThanOrEqual(committed.minimumSamples);
    expect(committed.samples.some((s) => s.label === "pass")).toBeTrue();
    expect(committed.samples.some((s) => s.label === "fail")).toBeTrue();
    expect(() => validateCalibrationSamples({ ...committed, samples: [{ ...sample("fail"), caseId: evalCases[0]!.id }] }, evalCases)).toThrow("failing items");
    expect(() => validateCalibrationSamples({ ...committed, samples: [{ ...sample("fail", ["nope"]), caseId: evalCases[0]!.id }] }, evalCases)).toThrow("unknown item");
  });
});

describe("every case can fail on the answer", () => {
  test("every case carries a rubric of yes/no questions", () => {
    for (const c of evalCases) expect(() => validateRubric(c), c.id).not.toThrow();
  });
  test("removed regex fields and empty rubrics are rejected", () => {
    const c = { id: "x", description: "", prompt: "", fixture: { evidence: {} }, expected: { rubric } } as EvalCase;
    expect(() => validateRubric({ ...c, expected: {} })).toThrow("at least one rubric item");
    expect(() => validateRubric({ ...c, expected: { rubric: [] } })).toThrow("at least one rubric item");
    expect(() => validateRubric({ ...c, expected: { rubric: [{ id: "a", question: "Reports blocked." }] } })).toThrow("yes/no question");
    expect(() => validateRubric({ ...c, expected: { rubric: [rubric[0]!, rubric[0]!] } })).toThrow("duplicate rubric id");
    for (const field of ["outputPatterns", "forbiddenOutputPatterns", "reportPatterns", "requiredActionDetails"])
      expect(() => validateRubric({ ...c, expected: { rubric, [field]: [] } as EvalCase["expected"] })).toThrow("was removed");
    expect(() => validateCases([{ ...c, expected: { rubric, forbiddenSkills: ["a", "a"] } }], new Set())).toThrow("duplicate forbiddenSkills");
  });
  test("for every case, any no verdict fails a run that passes every deterministic check", async () => {
    for (const c of evalCases) {
      const items = c.expected.rubric!;
      for (let flipped = -1; flipped < items.length; flipped++) {
        const runner: JudgeRunner = async ({ input }) => {
          const { answer } = JSON.parse(input);
          return {
            output: verdicts(items.map((item, i) => ({ id: item.id, verdict: i === flipped ? "no" : "yes", quote: answer.slice(0, 15) }))),
            responseModels: ["claude-opus-5-5"],
          };
        };
        const judged = await judgeAnswer({
          scope: "parent", judge: "claude:claude-opus-5-5", task: c.prompt, rubric: items,
          output: "A final answer.", actions: [], transcript: "/dev/null", runner,
        });
        const judgement = combineJudgement({ judge: "claude:claude-opus-5-5", crossFamily: true }, { calibrated: true, reason: "ok" }, [judged]);
        const outcome = rowOutcome({ grade: withJudgement({ passed: true, checks: [] }, judgement), judgement });
        expect(outcome, `${c.id} flipped=${flipped}`).toBe(flipped < 0 ? "pass" : "fail");
      }
    }
  });
});

describe("judging a run through the judge CLI", () => {
  const fakeJudge = (format: "codex" | "claude") =>
    [
      "#!/usr/bin/env bun",
      "const text = await new Response(Bun.stdin.stream()).text();",
      "const input = JSON.parse(text.replace(/^Scenario request:\\n\\n/, ''));",
      "const mode = process.env.FAKE_JUDGE_MODE ?? 'yes';",
      "const items = input.rubric.map((item, i) => ({ id: item.id, verdict: mode === 'no' && i === 0 ? 'no' : 'yes', quote: mode === 'noquote' ? '' : input.answer.split('\\n')[1].slice(0, 12) }));",
      format === "codex"
        ? "for (const event of [{type:'item.completed',item:{type:'agent_message',text:JSON.stringify({items})}},{type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}]) process.stdout.write(JSON.stringify(event)+'\\n');"
        : "for (const event of [{type:'assistant',message:{model:'claude-opus-5-5',content:[]}},{type:'result',structured_output:{items},modelUsage:{'claude-opus-5-5':{}}}]) process.stdout.write(JSON.stringify(event)+'\\n');",
    ].join("\n");
  test("parent and worker answers are judged with their own rubrics by the selected CLI", async () => {
    const work = await mkdtemp(join(tmpdir(), "kgr-judge-"));
    const saved = { codex: process.env.KGR_CODEX_BIN, claude: process.env.KGR_CLAUDE_BIN, mode: process.env.FAKE_JUDGE_MODE };
    try {
      for (const cli of ["codex", "claude"] as const) {
        const path = join(work, `fake-${cli}`);
        await Bun.write(path, fakeJudge(cli));
        await chmod(path, 0o700);
        process.env[cli === "codex" ? "KGR_CODEX_BIN" : "KGR_CLAUDE_BIN"] = path;
      }
      const worker: EvalCase = { id: "child", description: "", prompt: "Inspect", fixture: { evidence: {} }, expected: { rubric: [rubric[1]!] } };
      const parent: EvalCase = { id: "parent-case", description: "", prompt: "Deliver", fixture: { evidence: {} }, expected: { rubric }, worker: { model: "codex:w", caseId: "child" } };
      const record = (model: string): EvalRunRecord => ({
        model, caseId: parent.id, repetition: 1, output: "PR #7 is blocked at abc1234.",
        ledger: { ...emptyLedger(), workers: [{
          caseId: "child", model: "codex:w", observedModels: [], version: "", context: "Inspect PR #7",
          transcript: "", ledger: emptyLedger(), grade: { passed: true, checks: [] }, output: "Head abc1234 inspected.",
        }] },
        grade: { passed: true, checks: [] },
      });
      for (const [model, mode, status] of [
        ["claude:claude-fable-5-1", "yes", "pass"],
        ["codex:gpt-6-astra", "yes", "pass"],
        ["claude:claude-fable-5-1", "no", "fail"],
        ["codex:gpt-6-astra", "noquote", "fail"],
      ] as const) {
        process.env.FAKE_JUDGE_MODE = mode;
        const selection = selectJudge(model);
        const judgement = await judgeRecord({
          record: record(model), evalCase: parent, cases: [parent, worker],
          plan: { ...selection, calibrated: true, reason: "ok" },
          transcript: (scope) => join(work, `${model.replace(":", "-")}-${mode}-${scope}.jsonl`),
        });
        expect(judgement.judge).toBe(model.startsWith("codex") ? "claude:claude-opus-5-5" : "codex:gpt-6-sol");
        expect(judgement.answers.map((a) => [a.scope, a.items.map((i) => i.id)])).toEqual([
          ["parent", ["blocked", "head"]],
          ["child", ["head"]],
        ]);
        expect(judgement.status, `${model} ${mode}`).toBe(status);
      }
      const unavailable = await judgeRecord({
        record: record("codex:gpt-6-astra"), evalCase: parent, cases: [parent, worker],
        plan: { judge: "claude:claude-opus-5-5", crossFamily: true, calibrated: true, reason: "ok" },
        unavailable: "not logged in", transcript: () => join(work, "unused.jsonl"),
      });
      expect(unavailable.status).toBe("error");
      expect(unavailable.answers[0]!.error).toContain("not logged in");
    } finally {
      for (const [key, value] of [["KGR_CODEX_BIN", saved.codex], ["KGR_CLAUDE_BIN", saved.claude], ["FAKE_JUDGE_MODE", saved.mode]] as const)
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      await rm(work, { recursive: true, force: true });
    }
  });
});

describe("repeat aggregation", () => {
  const row = (caseId: string, repetition: number, outcome: "pass" | "fail" | "review" | "error"): EvalRunRecord => {
    const judgement = combineJudgement(
      { judge: "claude:j", crossFamily: true },
      { calibrated: outcome !== "review", reason: "" },
      [{ scope: "parent", status: outcome === "pass" ? "pass" : outcome === "error" ? "error" : "fail", items: [] }],
    );
    return {
      model: "codex:m", effort: "medium", caseId, repetition, output: "x", ledger: emptyLedger(),
      grade: { passed: outcome === "pass", checks: [] }, judgement,
    };
  };
  test("a case passes only when every repeat passes", () => {
    const result = aggregateRepeats([
      row("all-pass", 1, "pass"), row("all-pass", 2, "pass"), row("all-pass", 3, "pass"),
      row("one-fail", 1, "pass"), row("one-fail", 2, "fail"), row("one-fail", 3, "review"),
      row("review", 1, "pass"), row("review", 2, "review"), row("review", 3, "pass"),
      row("errored", 1, "pass"), row("errored", 2, "error"), row("errored", 3, "review"),
      row("short", 1, "pass"), row("short", 2, "pass"),
    ], 3);
    expect(Object.fromEntries(result.map((a) => [a.caseId, a.outcome]))).toEqual({
      "all-pass": "pass", "one-fail": "fail", review: "review", errored: "error", short: "error",
    });
    expect(result.find((a) => a.caseId === "one-fail")!.counts).toEqual({ pass: 1, fail: 1, review: 1, error: 0 });
  });
  test("three repeats are the default", () => {
    expect(parseCli([]).repeat).toBe(3);
    expect(parseCli(["--repeat", "1"]).repeat).toBe(1);
  });
});
