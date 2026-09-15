import { mkdir, realpath, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { freezeSnapshot, treeManifest } from "./snapshot.ts";
import { preflight, cancelLocalRuns, parseModel } from "./local-runtime.ts";
import { loadSkills, formatSkillCatalog } from "./skill-loader.ts";
import { buildSemanticPacket, packetDigest, type SemanticPacket } from "./semantic-review.ts";
import { runSemanticJudge, verifyCandidateTranscript } from "./semantic-review-runtime.ts";
import type { EvalCase, EvalRunRecord } from "./types.ts";
import { verifyToolReceiptTranscript } from "./tool-receipts.ts";
import { bindWorkerEvidence, type SemanticNode } from "./worker-evidence.ts";

const values = new Map<string, string[]>();
let execute = false;
for (let i = 2; i < Bun.argv.length; i++) {
  const flag = Bun.argv[i]!;
  if (flag === "--execute") { execute = true; continue; }
  if (!["--source", "--output", "--case", "--candidate-model"].includes(flag) || !Bun.argv[i + 1] || Bun.argv[i + 1]!.startsWith("--"))
    throw new Error("Unknown or missing argument: " + flag);
  values.set(flag, [...(values.get(flag) ?? []), Bun.argv[++i]!]);
}
if (!execute || process.env.CI || process.env.GITHUB_ACTIONS)
  throw new Error("Semantic review requires local --execute with native saved logins");
for (const flag of ["--source", "--output"])
  if (values.get(flag)?.length !== 1) throw new Error("Supply exactly one " + flag);
const caseIds = values.get("--case") ?? [];
if (!caseIds.length || new Set(caseIds).size !== caseIds.length)
  throw new Error("Select one or more distinct --case IDs");
const sourcePath = resolve(values.get("--source")![0]!);
const output = resolve(values.get("--output")![0]!);
const sourceBytes = await Bun.file(sourcePath).bytes();
const source = JSON.parse(new TextDecoder().decode(sourceBytes)) as {
  snapshot: string; records: EvalRunRecord[];
};
if (!source.snapshot || !Array.isArray(source.records)) throw new Error("Missing native source snapshot or records");
const originalRoot = await realpath(source.snapshot);
const manifest = await Bun.file(join(originalRoot, "manifest.json")).json() as Record<string, string>;
for (const required of ["evals/cases.ts", "evals/run.ts", "evals/tools.ts", "dependencies-manifest.json"])
  if (!manifest[required]) throw new Error("Missing original snapshot manifest entry: " + required);
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
for (const [name, expected] of Object.entries(manifest)) {
  const path = await realpath(resolve(originalRoot, name));
  const rel = relative(originalRoot, path);
  if (isAbsolute(name) || rel === ".." || rel.startsWith("../") || isAbsolute(rel) || hash(await Bun.file(path).bytes()) !== expected)
    throw new Error("Original snapshot file is invalid or changed: " + name);
}
const originalDependencies = await Bun.file(join(originalRoot, "dependencies-manifest.json")).json();
if (JSON.stringify(await treeManifest(join(originalRoot, "node_modules"))) !== JSON.stringify(originalDependencies))
  throw new Error("Original snapshot dependency tree changed");
const originalCases = (await import(pathToFileURL(join(originalRoot, "evals/cases.ts")).href)).evalCases as EvalCase[];
const originalInstructions = (await import(pathToFileURL(join(originalRoot, "evals/run.ts")).href)).portableAgentInstructions as (catalog: string) => string;
const skills = await loadSkills(originalRoot);
const selected = source.records.filter(record => caseIds.includes(record.caseId) &&
  (!values.has("--candidate-model") || values.get("--candidate-model")!.includes(record.model)));
for (const id of caseIds)
  if (!selected.some(record => record.caseId === id)) throw new Error("Requested case has no selected source row: " + id);
const jobs: {
  index: number; sourceIndex: number; sourceCaseId: string; sourceModel: string;
  role: SemanticNode["role"]; record: EvalRunRecord; packet: SemanticPacket;
  packetSha256: string; judge: string; sourceTranscript?: string;
}[] = [];
const harnessInstructions = originalInstructions(formatSkillCatalog(skills));
for (const [sourceIndex, record] of selected.entries()) {
  const scenario = originalCases.find(item => item.id === record.caseId);
  if (!scenario) throw new Error("Case absent from its source snapshot");
  let nodes: SemanticNode[] = [{
    role: "candidate", scenario, record, instructions: harnessInstructions, extraSources: [],
  }];
  if (scenario.worker || record.ledger.workers?.length) {
    if (!record.runtime?.transcript || record.ledger.workers?.length !== 1)
      throw new Error("Worker review requires parent and child transcripts");
    nodes = bindWorkerEvidence({
      scenario, record, cases: originalCases, instructions: harnessInstructions,
      parentTranscript: await Bun.file(record.runtime.transcript).text(),
      workerTranscript: await Bun.file(record.ledger.workers[0]!.transcript).text(),
    });
  } else {
    if (!record.runtime?.transcript) throw new Error("Candidate evidence lacks a native transcript");
    const transcript = await Bun.file(record.runtime.transcript).text();
    verifyCandidateTranscript(record, transcript);
    nodes[0]!.transcript = transcript;
  }
  for (const node of nodes) {
    const contracts = [];
    for (const name of new Set(node.record.ledger.loadedSkills)) {
      const skill = skills.get(name);
      if (!skill || !manifest[name + "/SKILL.md"]) throw new Error("Missing original loaded skill: " + name);
      contracts.push({ id: "contract:skill:" + name, text: skill.body });
    }
    for (const name of new Set(node.record.ledger.loadedReferences)) {
      if (!manifest[name]) throw new Error("Missing original loaded reference: " + name);
      contracts.push({ id: "contract:reference:" + name, text: await Bun.file(join(originalRoot, name)).text() });
    }
    const packet = buildSemanticPacket(node.scenario, node.record, contracts, node.instructions);
    packet.sources.push(...node.extraSources);
    if (new Set(packet.sources.map(item => item.id)).size !== packet.sources.length)
      throw new Error("Duplicate source identities in worker review");
    let sourceTranscript = node.transcript;
    if (node.record.ledger.toolReceiptVersion !== undefined) {
      if (sourceTranscript === undefined) {
        if (!node.record.runtime?.transcript) throw new Error("Captured evidence lacks a native transcript");
        sourceTranscript = await Bun.file(node.record.runtime.transcript).text();
      }
      verifyToolReceiptTranscript(node.record.ledger, parseModel(node.record.model).cli, sourceTranscript, node.receiptScope);
    }
    const judge = node.record.model === "claude:claude-fable-5-1" ? "claude:claude-opus-5" : "claude:claude-fable-5-1";
    jobs.push({
      index: jobs.length, sourceIndex, sourceCaseId: record.caseId, sourceModel: record.model,
      role: node.role, record: node.record, packet, packetSha256: packetDigest(packet), judge,
      ...(sourceTranscript === undefined ? {} : { sourceTranscript }),
    });
  }
}
await mkdir(output);
await Bun.write(join(output, "source-results.json"), sourceBytes);
await freezeSnapshot(join(output, "snapshot"));
await Bun.write(join(output, "plan.json"), JSON.stringify({
  source: sourcePath, sourceSha256: hash(sourceBytes),
  originalSnapshot: originalRoot, originalManifestSha256: hash(await Bun.file(join(originalRoot, "manifest.json")).bytes()),
  effort: "medium", interpretation: "Independent semantic review; original grades are retained, never overwritten",
  jobs: jobs.map(({ index, sourceIndex, sourceCaseId, sourceModel, role, record, judge, packetSha256, sourceTranscript }) => ({
    sourceIndex, sourceCaseId, sourceModel, role,
    index, caseId: record.caseId, candidateModel: record.model, repetition: record.repetition,
    originalGrade: record.grade, judge, packetSha256,
    ...(sourceTranscript === undefined ? {} : { sourceTranscriptSha256: hash(sourceTranscript) }),
  })),
}, null, 2) + "\n");
const versions = new Map<string, string>();
for (const judge of new Set(jobs.map(job => job.judge))) versions.set(judge, await preflight(judge));
let cancelled = false, next = 0;
const cancel = () => { cancelled = true; cancelLocalRuns(); };
process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
const results: unknown[] = [];
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
await Promise.all(Array.from({ length: Math.min(2, jobs.length) }, async () => {
  while (!cancelled && next < jobs.length) {
    const job = jobs[next++]!;
    const dir = join(output, String(job.index));
    await mkdir(dir);
    if (job.sourceTranscript !== undefined) await Bun.write(join(dir, "source-native.jsonl"), job.sourceTranscript);
    await Bun.write(join(dir, "packet.json"), JSON.stringify(job.packet, null, 2) + "\n");
    console.log("REVIEW", job.index, job.record.caseId, job.record.model);
    let outcome: Record<string, unknown>;
    try {
      const result = await runSemanticJudge({
        target: job.judge, packet: job.packet, directory: dir, snapshot: join(output, "snapshot"),
      });
      outcome = { status: "reviewed", ...result };
    } catch (error) {
      outcome = { status: "review_error", error: error instanceof Error ? error.message : String(error) };
    }
    results.push({
      sourceIndex: job.sourceIndex, sourceCaseId: job.sourceCaseId, sourceModel: job.sourceModel, role: job.role,
      index: job.index, caseId: job.record.caseId, candidateModel: job.record.model,
      judge: job.judge, judgeVersion: versions.get(job.judge), packetSha256: job.packetSha256,
      ...outcome,
    });
    await save();
    console.log("REVIEWED", job.index, outcome.status);
  }
}));
await save();
process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
if (cancelled) process.exitCode = 130;
else if (results.length !== jobs.length || results.some(result => (result as { status: string }).status !== "reviewed")) process.exitCode = 1;
