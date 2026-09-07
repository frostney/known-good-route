import { expect, test } from "bun:test";
import { requireRepairReviewSkills, validateRepairFindings } from "./stack-repair.ts";
const paths = ["src/store.mjs", "tests/store.test.mjs", "AGENTS.md"];
const probes = [{ id: "actual-failure", passed: false }, { id: "actual-success", passed: true }];
const finding = (patch = {}) => ({ path: "tests/store.test.mjs", line: 4, summary: "Coverage gap confirmed by CLI", witnessIds: ["actual-failure"], ...patch });
test("a witnessed finding in a read-only test file remains reviewable", () => {
  expect(() => validateRepairFindings({ verdict: "findings", findings: [finding(), finding({ path: "src/store.mjs", line: 6 })] }, paths, probes)).not.toThrow();
});
test("reviewable paths do not admit invented, passing or absent witnesses", () => {
  for (const witnessIds of [[], ["invented"], ["actual-success"], ["actual-failure", "invented"]])
    expect(() => validateRepairFindings({ verdict: "findings", findings: [finding({ witnessIds })] }, paths, probes)).toThrow("failing witness");
});
test("unknown paths and invalid anchors remain outside review scope", () => {
  for (const patch of [{ path: "../private.txt" }, { path: "unrelated.mjs" }, { line: 0 }, { line: 1.5 }])
    expect(() => validateRepairFindings({ verdict: "findings", findings: [finding(patch)] }, paths, probes)).toThrow("outside readable");
});
test("a reviewer receives the exact missing skill before spending effort on inspection", () => {
  expect(() => requireRepairReviewSkills(["code-review"])).toThrow("test-against-spec");
  expect(() => requireRepairReviewSkills(["test-against-spec"])).toThrow("code-review");
  expect(() => requireRepairReviewSkills(["code-review", "test-against-spec"])).not.toThrow();
});
