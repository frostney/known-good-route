import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allocateRepairAttempt, claimRepairFixture, repairAttemptConfiguration, repairAttemptPlan, repairConfigurationOwner, repairProtocol, repairSnapshotTreeDigest, verifyRepairConfiguration, verifyRepairExecutionConfiguration, verifyRepairSnapshot } from "./repair-resume.ts";
import { atomicJson } from "./issue-receipt.ts";
import { digest } from "./github-live.ts";
import { treeManifest } from "./snapshot.ts";
import { ownedProcessGroup } from "./process-group.ts";
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function directory() { const root = await mkdtemp(join(tmpdir(), "kgr-repair-resume-")); dirs.push(root); return root; }
async function frozen(destination?: string) {
  const root = destination ?? await directory(); await mkdir(root, { recursive: true }); await mkdir(join(root, "node_modules"));
  await Bun.write(join(root, "source.ts"), "original"); await Bun.write(join(root, "node_modules/library.js"), "dependency");
  await atomicJson(join(root, "dependencies-manifest.json"), await treeManifest(join(root, "node_modules")));
  const source = Object.fromEntries(await Promise.all(["source.ts", "dependencies-manifest.json"].map(async p => [p, digest(await Bun.file(join(root, p)).text())])));
  await atomicJson(join(root, "manifest.json"), source);
  return { root, hash: digest(await Bun.file(join(root, "manifest.json")).text()) };
}
async function stopped(root: string) {
  const attempt = await allocateRepairAttempt(root, false);
  const p = Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)"], { detached: true, stdout: "ignore", stderr: "ignore" });
  try {
    const owner = await ownedProcessGroup(p.pid);
    await atomicJson(join(attempt.directory, "runner.json"), owner.leader);
    await atomicJson(join(attempt.directory, "native-group.json"), owner);
    process.kill(-p.pid, "SIGKILL"); await p.exited;
    return attempt;
  } finally { try { process.kill(-p.pid, "SIGKILL"); } catch (e: any) { if (e.code !== "ESRCH") throw e; } await p.exited; }
}
test("resume verifies both frozen source and complete dependency tree", async () => {
  const f = await frozen(); await expect(verifyRepairSnapshot(f.root, f.hash)).resolves.toBeUndefined();
});
test("changed or added source cannot enter a resumed repair", async () => {
  for (const name of ["source.ts", "extra.ts"]) {
    const f = await frozen(); await Bun.write(join(f.root, name), "changed");
    await expect(verifyRepairSnapshot(f.root, f.hash)).rejects.toThrow("source changed");
  }
});
test("dependency content and mode changes invalidate resume", async () => {
  for (const mode of [false, true]) {
    const f = await frozen();
    if (mode) await chmod(join(f.root, "node_modules/library.js"), 0o700);
    else await Bun.write(join(f.root, "node_modules/library.js"), "changed");
    await expect(verifyRepairSnapshot(f.root, f.hash)).rejects.toThrow("dependencies changed");
  }
});
test("a replacement manifest cannot redefine the admitted source", async () => {
  const f = await frozen(); await Bun.write(join(f.root, "manifest.json"), "{}");
  await expect(verifyRepairSnapshot(f.root, f.hash)).rejects.toThrow("manifest changed");
});
test("an active or incompletely recorded attempt blocks a second native launch", async () => {
  const root = await directory(), first = await allocateRepairAttempt(root, false);
  await expect(allocateRepairAttempt(root, true)).rejects.toThrow("ownership is incomplete");
  await atomicJson(join(first.directory, "native-group.json"), { leader: { pid: 1, birth: "placeholder" }, group: 1 });
  await expect(allocateRepairAttempt(root, true)).rejects.toThrow("runner is still live");
  expect(await readdir(join(root, "attempts"))).toEqual(["0001"]);
});
test("a stopped attempt permits exactly one racing continuation allocation", async () => {
  const root = await directory(); await stopped(root);
  const results = await Promise.allSettled([allocateRepairAttempt(root, true), allocateRepairAttempt(root, true)]);
  expect(results.filter(r => r.status === "fulfilled").length).toBe(1);
  expect((await readdir(join(root, "attempts"))).sort()).toEqual(["0001", "0002"]);
});
test("missing history cannot be mistaken for a fresh or complete repair", async () => {
  const root = await directory();
  await expect(allocateRepairAttempt(root, true)).rejects.toThrow("fresh run");
  await mkdir(join(root, "attempts/0002"));
  await expect(allocateRepairAttempt(root, true)).rejects.toThrow("history is incomplete");
});
test("a fresh run cannot reuse another run's fixture even when its checkout is clean", async () => {
  const path = join(await directory(), "fixture-owner.json");
  await claimRepairFixture(path, { evidence: "/original", head: "same" });
  await expect(claimRepairFixture(path, { evidence: "/new-output", head: "same" })).rejects.toThrow("already belongs");
});
test("racing fresh runs have one fixture owner", async () => {
  const path = join(await directory(), "fixture-owner.json");
  const results = await Promise.allSettled([claimRepairFixture(path, { evidence: "/one" }), claimRepairFixture(path, { evidence: "/two" })]);
  expect(results.filter(r => r.status === "fulfilled").length).toBe(1);
});

test("full snapshot binding rejects source modes, empty directories and internal aliases", async () => {
  const mutations = [
    (root: string) => chmod(join(root, "source.ts"), 0o711),
    (root: string) => chmod(join(root, "source.ts"), 0o4644),
    (root: string) => chmod(root, 0o711),
    (root: string) => mkdir(join(root, "empty-extra-directory")),
    (root: string) => symlink("source.ts", join(root, "extra-alias.ts")),
  ];
  for (const mutate of mutations) {
    const f = await frozen(), tree = await repairSnapshotTreeDigest(f.root);
    await expect(verifyRepairSnapshot(f.root, f.hash, tree)).resolves.toBeUndefined();
    await mutate(f.root);
    // These changes retain the old file-content manifest and were previously missed.
    await expect(verifyRepairSnapshot(f.root, f.hash)).resolves.toBeUndefined();
    await expect(verifyRepairSnapshot(f.root, f.hash, tree)).rejects.toThrow("topology or permissions changed");
  }
});
test("the snapshot root cannot be replaced by a symlink to identical bytes", async () => {
  const parent = await directory(), f = await frozen(join(parent, "snapshot")), tree = await repairSnapshotTreeDigest(f.root);
  await rename(f.root, join(parent, "moved")); await symlink("moved", f.root);
  await expect(verifyRepairSnapshot(f.root, f.hash, tree)).rejects.toThrow("not a real directory");
});
async function configuration() {
  const root = await directory(), f = await frozen(join(root, "snapshot"));
  await atomicJson(join(root, "plan.json"), { scope: "one controlled stack" });
  await atomicJson(join(root, "no-automation-policy.json"), { automations: [] });
  const config: any = { protocolVersion: repairProtocol, evidence: root, skillsRoot: f.root,
    fixtureOwnerPath: join(root, "owner.json"), snapshotDigest: f.hash, snapshotTreeDigest: await repairSnapshotTreeDigest(f.root),
    planDigest: digest(await Bun.file(join(root, "plan.json")).text()), policyDigest: digest(await Bun.file(join(root, "no-automation-policy.json")).text()),
    model: "claude:claude-opus-5", directory: "/fixture", nativeBinary: "/native/claude", nodeBinary: "/runtime/node",
    bunVersion: Bun.version, interruptAfter: "fixCommitted", stack: { number: 25, members: [23, 24] } };
  const owner = repairConfigurationOwner(config);
  await claimRepairFixture(config.fixtureOwnerPath, owner);
  config.fixtureOwner = owner;
  await atomicJson(join(root, "config.json"), config);
  return { root, config };
}
test("the admitted complete configuration, plan and policy verify unchanged", async () => {
  const f = await configuration(); await expect(verifyRepairConfiguration(f.config, f.root)).resolves.toBeUndefined();
  await verifyRepairSnapshot(f.config.skillsRoot, f.config.snapshotDigest, f.config.snapshotTreeDigest);
});
test("changed nested config, runtime paths, model or extra fields cannot resume", async () => {
  const f = await configuration();
  for (const patch of [{ model: "claude:claude-fable-5-1" }, { directory: "/other" }, { nativeBinary: "/other/claude" },
    { nodeBinary: "/other/node" }, { bunVersion: "different" }, { interruptAfter: null }, { snapshotTreeDigest: "0".repeat(64) },
    { stack: { number: 25, members: [23, 99] } }, { extraAuthority: true }])
    await expect(verifyRepairConfiguration({ ...f.config, ...patch }, f.root)).rejects.toThrow("configuration changed");
});
test("recomputing a modified config's owner copy does not replace its original authority", async () => {
  const f = await configuration(); const { fixtureOwner, ...changed } = { ...f.config, model: "claude:claude-fable-5-1" };
  await expect(verifyRepairConfiguration({ ...changed, fixtureOwner: repairConfigurationOwner(changed) }, f.root)).rejects.toThrow("different request");
});
test("plan and policy cannot be changed behind unchanged configuration", async () => {
  for (const name of ["plan.json", "no-automation-policy.json"]) {
    const f = await configuration(); await atomicJson(join(f.root, name), { changed: true });
    await expect(verifyRepairConfiguration(f.config, f.root)).rejects.toThrow("plan or review policy changed");
  }
});
test("ownership cannot be redirected through a symlink or another evidence root", async () => {
  const f = await configuration();
  await expect(verifyRepairConfiguration(f.config, await directory())).rejects.toThrow("configuration changed");
  await rename(f.config.fixtureOwnerPath, f.config.fixtureOwnerPath + ".real");
  await symlink(f.config.fixtureOwnerPath + ".real", f.config.fixtureOwnerPath);
  await expect(verifyRepairConfiguration(f.config, f.root)).rejects.toThrow("ownership");
});
test("legacy roots are not silently promoted to the stronger resume contract", async () => {
  const f = await configuration();
  await expect(verifyRepairConfiguration({ ...f.config, protocolVersion: 2 }, f.root)).rejects.toThrow("Legacy repair evidence");
});
test("coordinator and reviewer configs inherit the complete admitted root configuration", async () => {
  const f = await configuration();
  for (const number of [1, 2]) {
    const directory = join(f.root, "attempts", String(number).padStart(4, "0")); await mkdir(directory, { recursive: true });
    await atomicJson(join(directory, "plan.json"), repairAttemptPlan(f.config, number));
    const config = repairAttemptConfiguration(f.config, directory, number);
    await verifyRepairExecutionConfiguration(config, join(directory, "config.json"));
    expect(config.interruptAfter).toBe(number === 1 ? "fixCommitted" : null);
    const reviewer = { ...config, reviewScope: { kind: "local-fix", pr: null, head: null } };
    await verifyRepairExecutionConfiguration(reviewer, join(f.root, `review-${crypto.randomUUID()}-config.json`));
    await expect(verifyRepairExecutionConfiguration({ ...reviewer, model: "changed" }, join(f.root, `review-${crypto.randomUUID()}-config.json`)))
      .rejects.toThrow("overrides its admitted configuration");
  }
});
test("an attempt plan or ownership path cannot redirect native execution", async () => {
  const f = await configuration(), directory = join(f.root, "attempts/0001"); await mkdir(directory, { recursive: true });
  const config = repairAttemptConfiguration(f.config, directory, 1), path = join(directory, "config.json");
  await atomicJson(join(directory, "plan.json"), repairAttemptPlan(f.config, 1));
  await expect(verifyRepairExecutionConfiguration({ ...config, ownershipFile: "/other/group.json" }, path)).rejects.toThrow("overrides");
  await expect(verifyRepairExecutionConfiguration({ ...config, reviewScope: { kind: "local-fix" } }, path)).rejects.toThrow("review configuration");
  await atomicJson(join(directory, "plan.json"), { ...repairAttemptPlan(f.config, 1), resumed: true });
  await expect(verifyRepairExecutionConfiguration(config, path)).rejects.toThrow("attempt plan changed");
});
