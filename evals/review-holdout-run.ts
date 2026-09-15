import { mkdir, cp } from "node:fs/promises";
import { freezeSnapshot } from "./snapshot.ts";
import { join, resolve } from "node:path";
import { command, digest } from "./github-live.ts";
import { atomicJson } from "./issue-receipt.ts";
import { loadSkills, formatSkillCatalog } from "./skill-loader.ts";
import { preflight, runLocal, defaultModels } from "./local-runtime.ts";
import { issueCase } from "./issue-live.ts";
import { gradeReviewFindings, type ReviewConfig } from "./review-holdout.ts";
if (
  process.env.CI ||
  process.env.GITHUB_ACTIONS ||
  !Bun.argv.includes("--execute")
)
  throw new Error(
    "Native review holdouts require explicit local --execute outside CI",
  );
const arg = (name: string) => {
  const i = Bun.argv.indexOf(name);
  return i < 0 ? undefined : Bun.argv[i + 1];
};
if (!arg("--holdout") || !arg("--output"))
  throw new Error("Supply frozen --holdout and new --output directories");
const holdout = resolve(arg("--holdout")!),
  output = resolve(arg("--output")!);
const manifest = await Bun.file(join(holdout, "manifest.json")).json();
const models = arg("--model") ? [arg("--model")!] : defaultModels;
if (models.some((m) => !defaultModels.includes(m)))
  throw new Error("Use an exact native model");
const node = process.env.KGR_NODE_BIN ?? Bun.which("node");
if (!node) throw new Error("Node24 required");
await mkdir(output);
const skillsRoot = join(output, "snapshot");
const { hashes } = await freezeSnapshot(skillsRoot);
const jobs: any[] = [];
for (const [variant, item] of Object.entries(manifest.variants) as Array<
  [string, { sha256: string; expected: "clean" | "defect" }]
>) {
  if (
    !/^[a-z-]+$/.test(variant) ||
    !["clean", "defect"].includes(item.expected)
  )
    throw new Error("Invalid frozen variant");
  if (
    digest(await Bun.file(join(holdout, `${variant}.mjs`)).text()) !==
    item.sha256
  )
    throw new Error("Holdout changed since freeze");
  for (const model of models)
    jobs.push({
      id: crypto.randomUUID().slice(0, 12),
      variant,
      model,
      ...item,
    });
}
await atomicJson(join(output, "plan.json"), {
  frozenHoldout: manifest,
  jobs,
  sourceManifest: hashes,
  nodeVersion: await command([node, "--version"]),
  bunVersion: Bun.version,
});
let next = 0;
const results: any[] = [];
async function consume() {
  while (next < jobs.length) {
    const job = jobs[next++]!;
    const evidence = join(output, job.id);
    await mkdir(evidence);
    const c: ReviewConfig = {
      source: join(evidence, "app.mjs"),
      tests: join(evidence, "test.mjs"),
      sourceSha256: job.sha256,
      skillsRoot,
      node: node!,
      evidence,
    };
    await cp(join(holdout, `${job.variant}.mjs`), c.source);
    await cp(join(holdout, `${job.variant}-workspace/test.mjs`), c.tests);
    const config = join(evidence, "config.json");
    await atomicJson(config, c);
    let row: any;
    try {
      const version = await preflight(job.model);
      console.log("RUN", job.model, job.id);
      const result = await runLocal({
        target: job.model,
        effort: "medium",
        skillsRoot,
        evalCase: {
          ...issueCase,
          id: "review-holdout",
          prompt:
            "Use code-review to review this small CLI against its stated contract. Read the actual source and tests, investigate any potential defects with executable counterexamples, and submit your findings using submitReview. This is read-only. Do not assume there is a bug; report only supported defects. The provided tools expose the actual program and permit bounded probes.",
        },
        instructions:
          formatSkillCatalog(await loadSkills(skillsRoot)) +
          "\nUse only provided tools for this local read-only evaluation. No source edits, repository writes, delegation or network investigation are available. Submit a local review with concrete executable evidence. Source, contract and tests are exposed by inspectProgram; probeProgram executes actual CLI behavior. A failing probe is evidence, not a reason to modify the source.",
        transcript: join(evidence, "native.jsonl"),
        server: {
          path: join(skillsRoot, "evals/review-holdout-server.ts"),
          args: [config],
          approvedTools: [
            "loadSkill",
            "readSkillReference",
            "inspectProgram",
            "probeProgram",
            "submitReview",
          ],
        },
      });
      await atomicJson(join(evidence, "native-result.json"), result);
      const state = await Bun.file(
        join(evidence, "review-evidence.json"),
      ).json();
      const checks = {
        runtime: !result.error,
        reviewProcedure: result.ledger.loadedSkills.includes("code-review"),
        sourceInspected: result.ledger.inspections.includes("program"),
        unchangedSource:
          digest(await Bun.file(c.source).text()) === c.sourceSha256,
        correctVerdictAndWitness: gradeReviewFindings(
          state.result,
          state.probes,
          job.expected,
          job.sha256,
        ),
      };
      row = {
        ...job,
        version,
        checks,
        passed: Object.values(checks).every(Boolean),
        submittedReview: state.result,
        probeCount: state.probes.length,
        evidence,
        error: result.error,
      };
      console.log(
        row.passed ? "PASS" : "FAIL",
        job.model,
        job.id,
        JSON.stringify(checks),
      );
    } catch (error) {
      row = { ...job, passed: false, error: String(error), evidence };
      console.log("ERROR", job.model, job.id, String(error));
    }
    results.push(row);
    await atomicJson(join(evidence, "result.json"), row);
  }
}
await Promise.all([consume(), consume()]);
await atomicJson(join(output, "results.json"), {
  passed: results.filter((r) => r.passed).length,
  total: results.length,
  results,
});
if (results.some((r) => !r.passed)) process.exitCode = 1;
