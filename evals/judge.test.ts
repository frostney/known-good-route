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
  calibrationItems,
  combineJudgement,
  judgeAnswer,
  judgeInput,
  judgeItems,
  judgeTask,
  messageRubric,
  judgesFromFlags,
  loadJudgeCalibration,
  parseJudgeOutput,
  renderAnswer,
  rowOutcome,
  scoreCalibration,
  selectJudge,
  terminalItem,
  validateCalibrationSamples,
  withJudgement,
  type CalibrationSample,
  type JudgeCalibration,
  type JudgeItem,
  type JudgeRunner,
  type RubricVerdict,
} from "./judge.ts";
import { judgeRecord, parseCli } from "./run.ts";
import type { EvalCase, EvalRunRecord, RubricItem, RunLedger } from "./types.ts";

const rubric: RubricItem[] = [
  { id: "blocked", question: "Does the answer report that PR #7 is blocked by the failing check?" },
  { id: "head", question: "Does the answer name head revision abc1234?" },
];
const items: JudgeItem[] = rubric.map((item) => ({ ...item, kind: "outcome" }));
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
    expect(JSON.parse(judgeInput("Task", items, answer))).toEqual({ task: "Task", items, answer });
  });
  test("every rubric item gets exactly one verdict in rubric order", () => {
    const parsed = parseJudgeOutput(
      verdicts([
        { id: "head", verdict: "yes", quote: "head abc1234" },
        { id: "blocked", verdict: "yes", quote: "PR #7 is blocked" },
      ]),
      items,
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
      expect(() => parseJudgeOutput(raw, items, answer)).toThrow();
  });
});

describe("quote enforcement", () => {
  const judge = (quote: string, verdict: "yes" | "no" = "yes") =>
    parseJudgeOutput(
      verdicts([
        { id: "blocked", verdict, quote },
        { id: "head", verdict: "yes", quote: "abc1234" },
      ]),
      items,
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
      items,
      answer,
    );
    expect(parsed[0]!.passed).toBeFalse();
  });
});

describe("cross-family judge choice", () => {
  test("Claude judges Codex runs and Codex judges Claude runs by default", () => {
    expect(selectJudge("codex:gpt-6-astra")).toEqual({ judge: "claude:claude-opus-5-5", crossFamily: true });
    expect(selectJudge("claude:claude-fable-5-1")).toEqual({ judge: "codex:gpt-6.1-sol", crossFamily: true });
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

const sample = (labels: Record<string, "yes" | "no">, id = "s1", terminal: "yes" | "no" = "yes"): CalibrationSample => ({
  id, round: 2, use: "held-out", caseId: "c", model: "codex:m", prompt: "Task", output: "x",
  rubric: Object.keys(labels).map((key) => ({ id: key, question: `Is ${key} right?` })),
  labels, terminal, labelledBy: "founder",
});
const verdict = (id: string, passed: boolean): RubricVerdict => ({
  id, question: "?", verdict: passed ? "yes" : "no", quote: passed ? "x" : "", quoteFound: passed, passed,
});

describe("calibration gate", () => {
  test("agreement is per item against the labeller, with the terminal question counted apart", () => {
    const result = scoreCalibration(
      [sample({ a: "yes", b: "no" }, "s1", "no"), sample({ a: "no", b: "yes" }, "s2"), sample({ a: "yes" }, "s3")],
      [
        [verdict("a", true), verdict("b", false), verdict("terminal-state", true)],
        [verdict("a", true), verdict("b", true), verdict("terminal-state", true)],
        undefined,
      ],
      "digest", "2026-10-01T00:00:00Z",
    );
    expect(result.samples).toBe(3);
    expect(result.outcome).toEqual({ total: 5, agreed: 3, agreement: 0.6, falsePasses: 1 });
    expect(result.message).toEqual({ total: 0, agreed: 0, agreement: 0, falsePasses: 0 });
    expect(result.terminal).toEqual({ total: 3, agreed: 1, agreement: 1 / 3, falsePasses: 1 });
    expect(result.disagreements).toContainEqual({ sample: "s1", caseId: "c", item: "terminal-state", label: "no", judged: "yes" });
    expect(result.disagreements).toContainEqual({ sample: "s3", caseId: "c", item: "a", label: "yes", judged: "error" });
  });
  const calibration = (results: JudgeCalibration["results"]): JudgeCalibration => ({
    agreementThreshold: 0.9, minimumSamples: 10, samples: [], results,
  });
  const scored = (agreeing: number, total: number, falsePass = false, terminalAgrees = true) => {
    const samples = Array.from({ length: total }, (_, i) => sample({ a: i === 0 && falsePass ? "no" : "yes" }, `s${i}`));
    const judged = samples.map((_, i) => [verdict("a", i < agreeing || (i === 0 && falsePass)), verdict("terminal-state", terminalAgrees)]);
    return scoreCalibration(samples, judged, "digest", "2026-10-01T00:00:00Z");
  };
  test("the gate opens only for a current, sufficient, accurate calibration on the rubric items", () => {
    expect(calibrationGate("codex:j", calibration({}), "digest").calibrated).toBeFalse();
    const good = scored(10, 10);
    expect(good.outcome).toMatchObject({ agreed: 10, total: 10, agreement: 1, falsePasses: 0 });
    expect(calibrationGate("codex:j", calibration({ "codex:j": good }), "digest").calibrated).toBeTrue();
    // The terminal question is reported, not gated.
    expect(calibrationGate("codex:j", calibration({ "codex:j": scored(10, 10, false, false) }), "digest").calibrated).toBeTrue();
    expect(calibrationGate("codex:j", calibration({ "codex:j": good }), "changed").reason).toContain("predates");
    expect(calibrationGate("codex:other", calibration({ "codex:j": good }), "digest").calibrated).toBeFalse();
    expect(calibrationGate("codex:j", calibration({ "codex:j": scored(9, 9) }), "digest").reason).toContain("required labelled answers");
    expect(calibrationGate("codex:j", calibration({ "codex:j": scored(8, 10) }), "digest").reason).toContain("below 0.9");
    const lenient = scored(10, 10, true);
    expect(lenient.outcome.falsePasses).toBe(1);
    expect(calibrationGate("codex:j", calibration({ "codex:j": lenient }), "digest").reason).toContain("judged as passing");
  });
  test("the digest covers the labels, the labelled items and the judge protocol", () => {
    const base = calibrationDigest([sample({ blocked: "yes", head: "yes" })]);
    expect(calibrationDigest([sample({ blocked: "yes", head: "no" })])).not.toBe(base);
    expect(calibrationDigest([sample({ blocked: "yes", head: "yes" }, "s1", "no")])).not.toBe(base);
    const reworded = sample({ blocked: "yes", head: "yes" });
    reworded.rubric[0]!.question = "Reworded?";
    expect(calibrationDigest([reworded])).not.toBe(base);
  });
  test("calibration asks each labelled item as an outcome item plus the terminal question", () => {
    expect(calibrationItems(sample({ a: "yes" })).map((item) => [item.id, item.kind])).toEqual([
      ["a", "outcome"], [terminalItem.id, "terminal"],
    ]);
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
  test("a message item failure is reported apart and waits for a person even with a calibrated judge", () => {
    const grade = { passed: true, checks: [] };
    const message = { ...verdict("concise", false), kind: "message" as const };
    const judged = { scope: "parent", status: "pass" as const, messageStatus: "fail" as const, items: [{ ...verdict("a", true), kind: "outcome" as const }, message] };
    const judgement = combineJudgement({ judge: "claude:j", crossFamily: true }, { calibrated: true, reason: "ok" }, [judged]);
    expect(judgement.status).toBe("pass");
    expect(judgement.messageStatus).toBe("fail");
    const checked = withJudgement(grade, judgement);
    expect(checked.checks.find((c) => c.name === "message concise")?.category).toBe("message");
    expect(rowOutcome({ grade: checked, judgement })).toBe("review");
  });
  test("every case is judged on its outcome items plus the shared message items", () => {
    const target = evalCases[0]!;
    const judged = judgeItems({ ...target, expected: { ...target.expected, messageRubric: [{ id: "names-the-pr", question: "Does the message name the PR?" }] } });
    expect(judged.filter((item) => item.kind === "outcome").map((item) => item.id)).toEqual(target.expected.rubric!.map((item) => item.id));
    expect(judged.filter((item) => item.kind === "message").map((item) => item.id)).toEqual([...messageRubric.map((item) => item.id), "names-the-pr"]);
    expect(messageRubric.length).toBeLessThanOrEqual(8);
    expect(() => validateRubric({ ...target, expected: { ...target.expected, messageRubric: [{ id: "concise", question: "Again?" }] } })).toThrow("duplicate rubric id");
  });
  test("the judge reads the repository settings that set how far the run goes", () => {
    const configured = evalCases.find((c) => c.fixture.environment?.orchestration?.endpoint === "merged")!;
    expect(judgeTask(configured)).toContain("endpoint merged and entry-points deliver");
    const stopping = { ...configured, fixture: { ...configured.fixture, environment: { orchestration: { endpoint: "ready-to-merge" as const, entryPoints: "stop" as const } } } };
    expect(judgeTask(stopping)).toContain("entry-points stop");
    const unconfigured = evalCases.find((c) => c.fixture.environment && c.fixture.environment.orchestration === null)!;
    expect(judgeTask(unconfigured)).toContain("no ORCHESTRATION.md");
    expect(judgeTask(unconfigured).startsWith(unconfigured.prompt)).toBeTrue();
  });
  test("labels must come from a named labeller and cover exactly the labelled items", async () => {
    const committed = await loadJudgeCalibration();
    validateCalibrationSamples(committed);
    const labelled = sample({ a: "yes", b: "no" });
    expect(() => validateCalibrationSamples({ ...committed, samples: [labelled] })).not.toThrow();
    expect(() => validateCalibrationSamples({ ...committed, samples: [{ ...labelled, labelledBy: " " }] })).toThrow("labeller");
    expect(() => validateCalibrationSamples({ ...committed, samples: [{ ...labelled, labels: { a: "yes" } }] })).toThrow("exactly");
    expect(() => validateCalibrationSamples({ ...committed, samples: [{ ...labelled, terminal: "maybe" as "yes" }] })).toThrow("yes or no");
    expect(() => validateCalibrationSamples({ ...committed, samples: [labelled, labelled] })).toThrow("unique id");
  });
  test("an imported label keeps the items, terminal verdict and notes as labelled", async () => {
    const { toSample } = await import("./judge-calibration.ts");
    const imported = toSample(
      { id: "L01", caseId: "c", model: "codex:gpt-6-astra", prompt: "Task", finalAnswer: "Done.", rubricItems: [{ key: "a", text: "Is a right?" }] },
      { items: { a: "no" }, terminal: "no", note: " Too long. ", terminalNote: "" },
      "founder",
      1,
      "tuning",
    );
    expect(imported).toEqual({
      id: "L01", round: 1, use: "tuning", caseId: "c", model: "codex:gpt-6-astra", prompt: "Task", output: "Done.",
      rubric: [{ id: "a", question: "Is a right?" }], labels: { a: "no" }, terminal: "no", note: "Too long.", labelledBy: "founder",
    });
  });
  test("each labelled answer is judged by the other family and scored per judge", async () => {
    const { calibrateJudges } = await import("./judge-calibration.ts");
    const work = await mkdtemp(join(tmpdir(), "kgr-calibrate-"));
    try {
      const path = join(work, "calibration.json");
      const samples = [
        { ...sample({ a: "yes" }, "c1"), model: "codex:gpt-6-astra" },
        { ...sample({ a: "no" }, "c2", "no"), model: "claude:claude-fable-5-1" },
      ];
      await Bun.write(path, JSON.stringify({ judgeCalibration: { agreementThreshold: 0.9, minimumSamples: 1, samples, results: {} } }));
      const seen: string[] = [];
      const runner: JudgeRunner = async ({ target, input }) => {
        seen.push(target);
        const { items: asked, answer } = JSON.parse(input);
        expect(asked.map((item: JudgeItem) => item.kind)).toEqual(["outcome", "terminal"]);
        return { output: verdicts(asked.map((item: JudgeItem) => ({ id: item.id, verdict: "yes", quote: answer.slice(0, 10) }))), responseModels: ["claude-opus-5-5"] };
      };
      const { results, combined, tuning } = await calibrateJudges({ directory: work, runner, calibrationPath: path });
      expect(tuning.combined.samples).toBe(0);
      expect(seen.sort()).toEqual(["claude:claude-opus-5-5", "codex:gpt-6.1-sol"]);
      expect(results["claude:claude-opus-5-5"]!.outcome).toEqual({ total: 1, agreed: 1, agreement: 1, falsePasses: 0 });
      expect(results["codex:gpt-6.1-sol"]!.outcome).toEqual({ total: 1, agreed: 0, agreement: 0, falsePasses: 1 });
      expect(combined.terminal).toEqual({ total: 2, agreed: 1, agreement: 0.5, falsePasses: 1 });
    } finally {
      await rm(work, { recursive: true, force: true });
    }
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
      const caseItems = judgeItems(c);
      for (let flipped = -1; flipped < caseItems.length; flipped++) {
        const runner: JudgeRunner = async ({ input }) => {
          const { answer } = JSON.parse(input);
          return {
            output: verdicts(caseItems.map((item, i) => ({ id: item.id, verdict: i === flipped ? "no" : "yes", quote: answer.slice(0, 15) }))),
            responseModels: ["claude-opus-5-5"],
          };
        };
        const judged = await judgeAnswer({
          scope: "parent", judge: "claude:claude-opus-5-5", task: c.prompt, items: caseItems,
          output: "A final answer.", actions: [], transcript: "/dev/null", runner,
        });
        const judgement = combineJudgement({ judge: "claude:claude-opus-5-5", crossFamily: true }, { calibrated: true, reason: "ok" }, [judged]);
        const outcome = rowOutcome({ grade: withJudgement({ passed: true, checks: [] }, judgement), judgement });
        // An outcome no fails the run; a message no waits for a person.
        const expected = flipped < 0 ? "pass" : caseItems[flipped]!.kind === "outcome" ? "fail" : "review";
        expect(outcome, `${c.id} flipped=${flipped}`).toBe(expected);
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
      "const items = input.items.map((item, i) => ({ id: item.id, verdict: (mode === 'no' && i === 0) || (mode === 'evidence' && !input.answer.includes('Reread the lock file')) ? 'no' : 'yes', quote: mode === 'noquote' ? '' : input.answer.split('\\n')[1].slice(0, 12) }));",
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
        expect(judgement.judge).toBe(model.startsWith("codex") ? "claude:claude-opus-5-5" : "codex:gpt-6.1-sol");
        expect(judgement.answers.map((a) => [a.scope, a.items.map((i) => i.id)])).toEqual([
          ["parent", ["blocked", "head", ...messageRubric.map((item) => item.id)]],
          ["child", ["head"]],
        ]);
        expect(judgement.status, `${model} ${mode}`).toBe(status);
      }
      process.env.FAKE_JUDGE_MODE = "evidence";
      const reviewed = record("codex:gpt-6-astra");
      for (const verdict of [undefined, { path: "/fixture/verdict.json", verdict: "agree" as const, evidence: "Reread the lock file." }]) {
        reviewed.ledger.workers![0]!.ledger = { ...emptyLedger(), ...(verdict ? { verdict } : {}) };
        const judged = await judgeRecord({
          record: reviewed, evalCase: parent, cases: [parent, worker],
          plan: { ...selectJudge("codex:gpt-6-astra"), calibrated: true, reason: "ok" },
          transcript: (scope) => join(work, `evidence-${!!verdict}-${scope}.jsonl`),
        });
        expect(judged.answers.find((a) => a.scope === "child")!.status, "a reviewer is judged with its verdict file").toBe(verdict ? "pass" : "fail");
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

describe("tuning and held-out rounds", () => {
  test("only held-out answers measure the judge; tuning answers are reported apart", async () => {
    const { calibrateJudges } = await import("./judge-calibration.ts");
    const work = await mkdtemp(join(tmpdir(), "kgr-rounds-"));
    try {
      const path = join(work, "calibration.json");
      const held = { ...sample({ a: "yes" }, "R2-01"), model: "codex:gpt-6-astra" };
      const tuned = { ...sample({ a: "no" }, "L01"), round: 1, use: "tuning" as const, model: "codex:gpt-6-astra" };
      await Bun.write(path, JSON.stringify({ judgeCalibration: { agreementThreshold: 0.9, minimumSamples: 1, samples: [held, tuned], results: {} } }));
      const runner: JudgeRunner = async ({ input }) => {
        const { items: asked, answer } = JSON.parse(input);
        return { output: verdicts(asked.map((item: JudgeItem) => ({ id: item.id, verdict: "yes", quote: answer.slice(0, 10) }))), responseModels: ["claude-opus-5-5"] };
      };
      const { results, tuning, gates } = await calibrateJudges({ directory: work, runner, calibrationPath: path });
      expect(results["claude:claude-opus-5-5"]!.samples).toBe(1);
      expect(results["claude:claude-opus-5-5"]!.outcome.falsePasses).toBe(0);
      expect(tuning.combined.outcome.falsePasses).toBe(1);
      expect(gates["claude:claude-opus-5-5"]!.calibrated).toBeTrue();
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
  test("a sample needs its round and use", () => {
    const bad = { ...sample({ a: "yes" }), use: "training" as "tuning" };
    expect(() => validateCalibrationSamples({ agreementThreshold: 0.9, minimumSamples: 1, samples: [bad], results: {} })).toThrow("round and use");
  });
  test("message items are scored apart and open their own gate", async () => {
    const { messageGate } = await import("./judge.ts");
    const labelled = { ...sample({ a: "yes", concise: "no" }), rubric: [{ id: "a", question: "A?" }, { id: "concise", question: "Concise?", kind: "message" as const }] };
    const lenient = scoreCalibration([labelled], [[verdict("a", true), verdict("concise", true), verdict("terminal-state", true)]], "d", "t");
    expect(lenient.outcome).toEqual({ total: 1, agreed: 1, agreement: 1, falsePasses: 0 });
    expect(lenient.message).toEqual({ total: 1, agreed: 0, agreement: 0, falsePasses: 1 });
    const calibration: JudgeCalibration = { agreementThreshold: 0.9, minimumSamples: 1, samples: [labelled], results: { "claude:j": lenient } };
    expect(calibrationGate("claude:j", calibration, "d").calibrated).toBeTrue();
    expect(messageGate("claude:j", calibration, "d").reason).toContain("message items the labeller failed");
    const strict = scoreCalibration([labelled], [[verdict("a", true), verdict("concise", false), verdict("terminal-state", true)]], "d", "t");
    expect(messageGate("claude:j", { ...calibration, results: { "claude:j": strict } }, "d").calibrated).toBeTrue();
    expect(messageGate("claude:j", { ...calibration, results: {} }, "d").calibrated).toBeFalse();
    expect(calibrationItems(labelled).map((item) => item.kind)).toEqual(["outcome", "message", "terminal"]);
  });
  test("a message failure fails the run only under a calibrated cross-family message gate", () => {
    const judged = { scope: "parent", status: "pass" as const, messageStatus: "fail" as const, items: [] };
    const grade = { passed: true, checks: [] };
    const open = combineJudgement({ judge: "claude:j", crossFamily: true }, { calibrated: true, reason: "ok", messageCalibrated: true }, [judged]);
    const closed = combineJudgement({ judge: "claude:j", crossFamily: true }, { calibrated: true, reason: "ok" }, [judged]);
    const sameFamily = combineJudgement({ judge: "claude:j", crossFamily: false }, { calibrated: true, reason: "ok", messageCalibrated: true }, [judged]);
    expect(rowOutcome({ grade, judgement: open })).toBe("fail");
    expect(rowOutcome({ grade, judgement: closed })).toBe("review");
    expect(rowOutcome({ grade, judgement: sameFamily })).toBe("review");
  });
  test("labelled answers carry no local machine paths, because the repository is public", async () => {
    const text = await Bun.file(new URL("./calibration.json", import.meta.url)).text();
    expect(text).not.toMatch(/\/(?:private\/tmp|Users|home)\/[^"\s]*/);
  });
  test("the committed round-1 labels are tuning-only", async () => {
    const committed = await loadJudgeCalibration();
    const round1 = committed.samples.filter((s) => s.round === 1);
    expect(round1.length).toBe(40);
    expect(round1.every((s) => s.use === "tuning")).toBeTrue();
  });
});

describe("judge effort", () => {
  test("the judge effort defaults to medium and a flag selects another", async () => {
    const { defaultJudgeEffort, parseJudgeEffort } = await import("./judge.ts");
    expect(defaultJudgeEffort).toBe("medium");
    expect(parseCli([]).judgeEffort).toBe("medium");
    expect(parseCli(["--judge-effort", "xhigh"]).judgeEffort).toBe("xhigh");
    expect(() => parseCli(["--judge-effort", "extreme"])).toThrow("Unsupported judge effort");
    expect(parseJudgeEffort(undefined)).toBe(defaultJudgeEffort);
  });
  test("the selected effort reaches the judge CLI and is recorded with the calibration", async () => {
    const seen: string[] = [];
    const runner: JudgeRunner = async ({ effort, input }) => {
      seen.push(effort);
      const { items: asked, answer } = JSON.parse(input);
      return { output: verdicts(asked.map((item: JudgeItem) => ({ id: item.id, verdict: "yes", quote: answer.slice(0, 10) }))), responseModels: ["claude-opus-5-5"] };
    };
    await judgeAnswer({ scope: "parent", judge: "claude:claude-opus-5-5", task: "T", items, output: "Done.", actions: [], transcript: "/dev/null", runner, effort: "high" });
    await judgeAnswer({ scope: "parent", judge: "claude:claude-opus-5-5", task: "T", items, output: "Done.", actions: [], transcript: "/dev/null", runner });
    expect(seen).toEqual(["high", "medium"]);
    const result = scoreCalibration([sample({ a: "yes" })], [[verdict("a", true)]], "digest", "2026-10-01T00:00:00Z", "xhigh");
    expect(result.effort).toBe("xhigh");
    const recorded: JudgeCalibration = { agreementThreshold: 0.9, minimumSamples: 1, samples: [], results: { "codex:j": result } };
    expect(calibrationGate("codex:j", recorded, "digest", "xhigh").calibrated).toBeTrue();
    expect(calibrationGate("codex:j", recorded, "digest", "medium").reason).toContain("calibrated at xhigh effort");
  });
});
