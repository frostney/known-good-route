import { lstat, mkdir, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { atomicJson, issueDigest } from "./issue-receipt.ts";
import { digest } from "./github-live.ts";
import { treeManifest } from "./snapshot.ts";
import { observeProcess, processIdentity } from "./process-identity.ts";
import { initializeRepairGroups, requireRepairGroupsStopped } from "./repair-processes.ts";
import { claimOperation, matchingIntent, readOperationIntent } from "./operation-intent.ts";

export const repairProtocol = 4;
export function repairConfigurationOwner(configuration: Record<string, unknown>) {
  if (configuration.fixtureOwner !== undefined) throw Error("Configuration must precede its ownership record");
  return { protocolVersion: repairProtocol, evidence: configuration.evidence, configurationDigest: issueDigest(configuration) };
}
export async function verifyRepairConfiguration(config: any, root: string) {
  if (config.protocolVersion !== repairProtocol)
    throw Error("Legacy repair evidence lacks complete configuration binding; preserve its frozen runner and original guarantees");
  const { fixtureOwner, ...configuration } = config;
  const expected = repairConfigurationOwner(configuration);
  if (!fixtureOwner || config.evidence !== root || config.skillsRoot !== join(root, "snapshot") ||
      issueDigest(fixtureOwner) !== issueDigest(expected)) throw Error("Repair configuration changed from its admitted ownership");
  const owner = await lstat(config.fixtureOwnerPath);
  if (!owner.isFile() || owner.isSymbolicLink() || !await matchingIntent(config.fixtureOwnerPath, expected))
    throw Error("Repair fixture ownership is missing or differs");
  if (digest(await Bun.file(join(root, "plan.json")).text()) !== config.planDigest ||
      digest(await Bun.file(join(root, "no-automation-policy.json")).text()) !== config.policyDigest)
    throw Error("Repair plan or review policy changed");
  if (!/^[0-9a-f]{64}$/.test(config.snapshotTreeDigest)) throw Error("Repair snapshot tree binding is missing");
}

async function snapshotTree(root: string, entries?: Awaited<ReturnType<typeof treeManifest>>) {
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw Error("Frozen snapshot root is not a real directory");
  return { rootMode: metadata.mode & 0o7777, entries: entries ?? await treeManifest(root) };
}
export async function repairSnapshotTreeDigest(root: string) {
  return issueDigest(await snapshotTree(root));
}
export function repairAttemptPlan(config: any, number: number) {
  return { attempt: number, resumed: number > 1, snapshotDigest: config.snapshotDigest,
    configurationDigest: config.fixtureOwner.configurationDigest, model: config.model, version: config.version };
}
export function repairAttemptConfiguration(config: any, directory: string, number: number) {
  return { ...config, attemptDirectory: directory, ownershipFile: join(directory, "native-group.json"),
    interruptAfter: number > 1 ? null : config.interruptAfter };
}
export async function verifyRepairExecutionConfiguration(config: any, configPath: string) {
  const root = await Bun.file(join(config.evidence, "config.json")).json();
  await verifyRepairConfiguration(root, config.evidence);
  const name = basename(config.attemptDirectory), number = Number(name);
  if (!/^\d{4}$/.test(name) || number < 1 || config.attemptDirectory !== join(root.evidence, "attempts", name))
    throw Error("Repair execution has an invalid attempt directory");
  const expected: any = repairAttemptConfiguration(root, config.attemptDirectory, number);
  if (config.reviewScope !== undefined) {
    if (!config.reviewScope || !["original", "local-fix", "published-fix"].includes(config.reviewScope.kind) ||
        !/^review-[0-9a-f-]{36}-config\.json$/.test(basename(configPath)) || configPath !== join(root.evidence, basename(configPath)))
      throw Error("Invalid independent review configuration path or scope");
    expected.reviewScope = config.reviewScope;
  } else if (configPath !== join(config.attemptDirectory, "config.json")) throw Error("Invalid coordinator configuration path");
  if (issueDigest(config) !== issueDigest(expected)) throw Error("Repair execution overrides its admitted configuration");
  if (issueDigest(await Bun.file(join(config.attemptDirectory, "plan.json")).json()) !== issueDigest(repairAttemptPlan(root, number)))
    throw Error("Repair attempt plan changed");
}

export async function claimRepairFixture(path: string, request: unknown) {
  if (await readOperationIntent(path) !== undefined) throw Error("Fixture already belongs to a native repair run; resume its recorded evidence");
  if (!await claimOperation(path, request)) throw Error("Another native repair run claimed this fixture");
}

export async function verifyRepairSnapshot(root: string, expectedManifestDigest: string, expectedTreeDigest?: string) {
  const file = Bun.file(join(root, "manifest.json"));
  if (digest(await file.text()) !== expectedManifestDigest) throw Error("Frozen source manifest changed");
  const expected = await file.json(), actual = await treeManifest(root);
  const sources = Object.fromEntries(Object.entries(actual).filter(([path, v]) =>
    !path.startsWith("node_modules/") && path !== "manifest.json" && v.type === "file").map(([path, v]) => [path, v.sha256]));
  if (Object.keys(sources).length !== Object.keys(expected).length || Object.entries(expected).some(([p, h]) => sources[p] !== h))
    throw Error("Frozen repair source changed");
  const dependencies = await Bun.file(join(root, "dependencies-manifest.json")).json();
  if (JSON.stringify(await treeManifest(join(root, "node_modules"))) !== JSON.stringify(dependencies))
    throw Error("Frozen repair dependencies changed");
  // The optional form is retained for read-only verification of historical runs.
  // New native runs always supply the independently owned full-tree digest.
  if (expectedTreeDigest && issueDigest(await snapshotTree(root, actual)) !== expectedTreeDigest)
    throw Error("Frozen repair tree topology or permissions changed");
}
export async function allocateRepairAttempt(root: string, resume: boolean) {
  const directory = join(root, "attempts"); await mkdir(directory, { recursive: true });
  const names = (await readdir(directory)).filter(n => /^\d{4}$/.test(n)).sort();
  if (names.some((n, i) => Number(n) !== i + 1)) throw Error("Repair attempt history is incomplete");
  if (resume ? !names.length : names.length > 0) throw Error("Choose a fresh run or an existing resumable run");
  for (const name of names) {
    const attempt = join(directory, name), runnerFile = Bun.file(join(attempt, "runner.json")), groupFile = Bun.file(join(attempt, "native-group.json"));
    if (!await runnerFile.exists() || !await groupFile.exists()) throw Error("Attempt ownership is incomplete; do not infer stopped processes");
    const runner = await runnerFile.json(), current = await observeProcess(runner.pid);
    if (current && !current.terminal && current.birth === runner.birth) throw Error("Repair runner is still live; do not resume");
    await requireRepairGroupsStopped(attempt, await groupFile.json());
  }
  const attempt = join(directory, String(names.length + 1).padStart(4, "0"));
  // mkdir is an exclusive attempt claim. A racing resumer cannot reuse it.
  await mkdir(attempt);
  await initializeRepairGroups(attempt);
  await atomicJson(join(attempt, "runner.json"), await processIdentity(process.pid));
  return { directory: attempt, number: names.length + 1 };
}
