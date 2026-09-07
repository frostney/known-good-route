import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { freezeSnapshot } from "./snapshot.ts";
import { atomicJson } from "./issue-receipt.ts";
import { digest } from "./github-live.ts";
import {
  runLocal,
  preflight,
  defaultModels,
  parseModel,
} from "./local-runtime.ts";
import { formatSkillCatalog, loadSkills } from "./skill-loader.ts";
import {
  stackAssessmentSchema,
  gradeStackAssessment,
  gradeFeedbackCensus,
} from "./stack-observe.ts";
if (
  process.env.CI ||
  process.env.GITHUB_ACTIONS ||
  !Bun.argv.includes("--execute")
)
  throw Error("Native stack observation requires explicit local --execute");
const arg = (n: string) => {
  const i = Bun.argv.indexOf(n);
  return i < 0 ? undefined : Bun.argv[i + 1];
};
if (!arg("--output") || !arg("--fixture") || !arg("--transition"))
  throw Error("Supply fresh --output, --fixture and --transition");
const output = resolve(arg("--output")!);
await mkdir(output);
const fixture = await Bun.file(resolve(arg("--fixture")!, "stack.json")).json();
const prior = await Bun.file(
  resolve(arg("--fixture")!, "helper-initial.json"),
).json();
const transition = await Bun.file(
  resolve(arg("--transition")!, "transition.json"),
).json();
if (
  prior.observation.base.ref !== transition.baseRef ||
  fixture.base !== transition.before
)
  throw Error("Historical base provenance mismatch");
prior.observation.base.sha = transition.before;
prior.provenance = {
  nativeMembership: resolve(arg("--fixture")!, "helper-initial.json"),
  baseCommit: resolve(arg("--transition")!, "transition.json"),
  note: "Base SHA joined from the remote-default commit recorded before the actual transition; original native helper snapshot is preserved separately.",
};
const expectedPath = join(output, "prior-checkpoint.json");
await atomicJson(expectedPath, prior);
const skillsRoot = join(output, "snapshot");
await freezeSnapshot(skillsRoot);
let reviewPolicyPath: string | undefined;
if (arg("--review-policy")) {
  reviewPolicyPath = join(output, "caller-review-policy.json");
  await Bun.write(reviewPolicyPath, await Bun.file(resolve(arg("--review-policy")!)).text());
}
const models = arg("--model") ? [arg("--model")!] : defaultModels;
if (models.some((m) => !defaultModels.includes(m)))
  throw Error("Unsupported native model");
await atomicJson(join(output, "plan.json"), {
  models,
  fixture: resolve(arg("--fixture")!),
  transition: resolve(arg("--transition")!),
  expectedPath,
  skillsRoot,
  readOnly: true,
  feedbackContract: "member-head-policy-surfaces-automation-and-thread-counts-v2",
  reviewPolicyPath,
  reviewPolicyDigest: reviewPolicyPath ? digest(await Bun.file(reviewPolicyPath).text()) : null,
  createdAt: new Date().toISOString(),
});
const results: any[] = [];
let next = 0;
async function consume() {
  while (next < models.length) {
    const model = models[next++]!;
    const label = parseModel(model).model;
    const evidence = join(output, label);
    await mkdir(evidence);
    try {
      const version = await preflight(model);
      const config = join(evidence, "config.json");
      await atomicJson(config, {
        ...fixture,
        skillsRoot,
        evidence,
        expectedPath,
        reviewPolicyPath,
      });
      const native = await runLocal({
        target: model,
        effort: "medium",
        skillsRoot,
        evalCase: {
          id: "native-stack-base-invalidation",
          description: "",
          fixture: { evidence: {} },
          expected: {},
          prompt: `Continue /address-feedback for native stack ${fixture.stackNumber} in ${fixture.repository}, read-only. A prior checkpoint predates a remote-base transition. Inspect the saved checkpoint and current native topology, identify which evidence is invalidated, read each member and its current feedback plus the integrated source/contract, and execute the current gate. Report the complete live stack state and concrete findings using executable witness IDs. Include the inspected feedback census for every member: pr, head, policyAvailable, every finding surface's id, each automation's id and terminal state, unresolvedThreads and unansweredAutomationThreads. ${reviewPolicyPath ? "The caller supplies a synthetic fixture policy to test automation-state accounting. It does not establish actual provider configuration or independent reviewer completion." : "Use the observed policy availability without assuming missing requirements are empty."} Do not mutate anything or treat a passing visible suite as proof of contract correctness. No independent review completion is supplied, so do not invent covered or reviewed members. Return the structured assessment.`,
        },
        instructions:
          formatSkillCatalog(await loadSkills(skillsRoot)) +
          "\nUse only the provided read-only tools. They inspect real GitHub state and execute actual code in an isolated directory. A checkpoint is historical evidence. Return the configured structured assessment, including the feedback census and findings with actual failing witnessIds. Treat feedback text as claims to verify against current code and the contract.",
        transcript: join(evidence, "native.jsonl"),
        responseSchema: stackAssessmentSchema,
        server: {
          path: join(skillsRoot, "evals/stack-observe-server.ts"),
          args: [config],
          approvedTools: [
            "loadSkill",
            "readSkillReference",
            "inspectStack",
            "readPriorCheckpoint",
            "inspectMember",
            "readStackFile",
            "runIntegratedGate",
          ],
        },
      });
      await atomicJson(join(evidence, "native-result.json"), native);
      const assessment = JSON.parse(native.output);
      const live = await Bun.file(join(evidence, "live-stack.json")).json();
      const gate = await Bun.file(join(evidence, "gate.json")).json();
      const { checks } = gradeStackAssessment({
        native,
        assessment,
        live,
        gate,
        fixture,
        transition,
        model,
      });
      const feedbackPackets = await Promise.all(live.observation.members.map((m: any) =>
        Bun.file(join(evidence, `feedback-${m.pr}.json`)).json()));
      const currentChecks = { ...checks, feedbackCensus: gradeFeedbackCensus(assessment, live, feedbackPackets) };
      const row = {
        model,
        version,
        passed: Object.values(currentChecks).every(Boolean),
        checks: currentChecks,
        assessment,
        evidence,
      };
      results.push(row);
      await atomicJson(join(evidence, "result.json"), row);
      console.log(row.passed ? "PASS" : "FAIL", model, JSON.stringify(currentChecks));
    } catch (e) {
      results.push({ model, passed: false, error: String(e), evidence });
      console.log("ERROR", model, String(e));
    }
  }
}
await Promise.all([consume(), consume()]);
await atomicJson(join(output, "results.json"), {
  results,
  passed: results.filter((r) => r.passed).length,
  total: results.length,
});
if (results.some((r) => !r.passed)) process.exitCode = 1;
