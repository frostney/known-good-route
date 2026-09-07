import { mkdir, rename } from "node:fs/promises";
import { resolve, join } from "node:path";
import { freezeSnapshot } from "./snapshot.ts";
import { cancelLocalRuns, preflight } from "./local-runtime.ts";
import { packetDigest } from "./semantic-review.ts";
import { semanticControls } from "./semantic-review-controls.ts";
import { checkRequiredOutcomes } from "./outcome-claims.ts";
import { runSemanticJudge } from "./semantic-review-runtime.ts";

if (Bun.argv.length !== 5 || Bun.argv[2] !== "--execute" || Bun.argv[3] !== "--output" ||
    !Bun.argv[4] || Bun.argv[4].startsWith("--") || process.env.CI || process.env.GITHUB_ACTIONS)
  throw new Error("Use local saved logins: bun evals/semantic-control-run.ts --execute --output <new-directory>");
const output = resolve(Bun.argv[4]);
await mkdir(output);
const snapshot = join(output, "snapshot");
await freezeSnapshot(snapshot);
const jobs = ["claude:claude-fable-5-1", "claude:claude-opus-5"].flatMap(target =>
  semanticControls.map(control => ({ target, control })));
await Bun.write(join(output, "plan.json"), JSON.stringify({
  interpretation: "Authored semantic judge calibration controls, not candidate evaluations or unseen holdouts",
  effort: "medium", jobs: jobs.map(({ target, control }) => ({
    target, id: control.id, expected: control.expected, requiredKind: control.requiredKind, requiredOutcomeClaims: control.requiredOutcomeClaims,
    packetSha256: packetDigest(control.packet),
  })),
}, null, 2) + "\n");
const versions = new Map<string, string>();
for (const target of new Set(jobs.map(job => job.target))) versions.set(target, await preflight(target));
let next = 0, cancelled = false;
const cancel = () => { cancelled = true; cancelLocalRuns(); };
process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
const results: { index: number; passed: boolean; [key: string]: unknown }[] = [];
let checkpoint = Promise.resolve();
function save() {
  checkpoint = checkpoint.then(async () => {
    const path = join(output, "results.json");
    await Bun.write(path + ".tmp", JSON.stringify({ planned: jobs.length, completed: results.length, cancelled, results }, null, 2) + "\n");
    await rename(path + ".tmp", path);
  });
  return checkpoint;
}
await save();
await Promise.all(Array.from({ length: 2 }, async () => {
  while (!cancelled && next < jobs.length) {
    const index = next++, { target, control } = jobs[index]!;
    const directory = join(output, String(index));
    await mkdir(directory);
    await Bun.write(join(directory, "packet.json"), JSON.stringify(control.packet, null, 2) + "\n");
    console.log("CONTROL", index, control.id, target);
    let outcome: { passed: boolean; [key: string]: unknown };
    try {
      const result = await runSemanticJudge({ target, packet: control.packet, directory, snapshot });
      const outcomeCoverage=checkRequiredOutcomes(control.requiredOutcomeClaims??[],await Bun.file(join(directory,"claim-inventory.json")).json(),result.review.outcomeChecks);
      outcome = {
        status: "reviewed", ...result, outcomeCoverage,
        passed: outcomeCoverage.every(check=>check.passed) && result.review.verdict === control.expected &&
          (!control.requiredKind || result.review.findings.some(finding => finding.kind === control.requiredKind)),
      };
    } catch (error) {
      outcome = { status: "review_error", passed: false, error: error instanceof Error ? error.message : String(error) };
    }
    results.push({ index, id: control.id, target, version: versions.get(target), ...outcome });
    await save();
    console.log("CONTROLLED", index, outcome.passed);
  }
}));
await save();
process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
if (cancelled) process.exitCode = 130;
else if (results.length !== jobs.length || results.some(result => !result.passed)) process.exitCode = 1;
