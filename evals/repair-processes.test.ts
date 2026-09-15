import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initializeRepairGroups, registerRepairServer, requireRepairGroupsStopped, stopRepairServerGroups } from "./repair-processes.ts";
import { ownedProcessGroup } from "./process-group.ts";
import { atomicJson } from "./issue-receipt.ts";
const modulePath = resolve(import.meta.dir, "repair-processes.ts");
async function waitFile(path: string) {
  const deadline = Date.now() + 5000;
  while (!await Bun.file(path).exists()) { if (Date.now() > deadline) throw Error("Fixture server startup timed out"); await Bun.sleep(10); }
  return Bun.file(path).json();
}
async function fixture(detached = true, nested = false) {
  const root = await mkdtemp(join(tmpdir(), "kgr-server-groups-")); await initializeRepairGroups(root);
  const server = join(root, "server.ts"), ready = join(root, "ready.json"), ownerPath = join(root, "owner.json");
  await Bun.write(server, `import {registerRepairServer} from ${JSON.stringify(modulePath)};
while (!await Bun.file(${JSON.stringify(ownerPath)}).exists()) await Bun.sleep(10);
try { const owner=await registerRepairServer(${JSON.stringify(root)},await Bun.file(${JSON.stringify(ownerPath)}).json());
await Bun.write(Bun.argv[2] === "nested" ? ${JSON.stringify(ready + ".nested")} : ${JSON.stringify(ready)},JSON.stringify({owner,pid:process.pid}));
if (${nested} && Bun.argv[2] !== "nested") Bun.spawn([process.execPath,import.meta.path,"nested"],{detached:true,stdout:"ignore",stderr:"ignore"});
setInterval(()=>{},1000);
} catch(e) { await Bun.write(${JSON.stringify(ready)},JSON.stringify({error:String(e)})); process.exit(1); }`);
  const code = `const child=Bun.spawn([process.execPath,${JSON.stringify(server)}],{detached:${detached},stdout:"ignore",stderr:"ignore"}); setInterval(()=>{},1000);`;
  const p = Bun.spawn([process.execPath, "-e", code], { detached: true, stdout: "ignore", stderr: "ignore" });
  const owner = await ownedProcessGroup(p.pid); await atomicJson(ownerPath, owner);
  const child = await waitFile(ready);
  if (child.error) throw Error(child.error);
  const grandchild = nested ? await waitFile(ready + ".nested") : undefined;
  return { root, p, owner, child, grandchild, async close() {
    for (const pid of [grandchild?.pid, child.pid, p.pid].filter(Boolean)) try { process.kill(-pid, "SIGKILL"); } catch (e: any) { if (e.code !== "ESRCH") throw e; }
    await p.exited; await rm(root, { recursive: true, force: true });
  } };
}

test("a detached descendant registers before tools and blocks recovery after parent exit", async () => {
  const f = await fixture();
  try {
    expect(f.child.owner.group).toBe(f.child.pid);
    expect(f.child.owner.group).not.toBe(f.owner.group);
    expect(await readdir(join(f.root, "server-groups"))).toEqual([`${f.child.pid}.json`]);
    f.p.kill("SIGKILL"); await f.p.exited;
    await expect(requireRepairGroupsStopped(f.root, f.owner)).rejects.toThrow("still live");
    await stopRepairServerGroups(f.root, f.owner);
    await expect(requireRepairGroupsStopped(f.root, f.owner)).resolves.toBeUndefined();
  } finally { await f.close(); }
});

test("same-group server admission retains the original native owner", async () => {
  const f = await fixture(false);
  try {
    expect(f.child.owner).toEqual(f.owner);
    expect(await readdir(join(f.root, "server-groups"))).toEqual([]);
    process.kill(-f.p.pid, "SIGKILL"); await f.p.exited;
    await stopRepairServerGroups(f.root, f.owner);
  } finally { await f.close(); }
});

test("unrelated processes cannot register under another live native owner", async () => {
  const f = await fixture();
  try {
    await expect(registerRepairServer(f.root, f.owner)).rejects.toThrow("not a live descendant");
    expect(await readdir(join(f.root, "server-groups"))).toEqual([`${f.child.pid}.json`]);
  } finally { await f.close(); }
});

test("unknown group entries prevent recovery instead of being ignored", async () => {
  const f = await fixture();
  try {
    await Bun.write(join(f.root, "server-groups/unrecognized.json"), "{}");
    process.kill(-f.p.pid, "SIGKILL"); await f.p.exited;
    await expect(requireRepairGroupsStopped(f.root, f.owner)).rejects.toThrow();
  } finally { await f.close(); }
});


test("nested reviewer server groups remain owned after the native root exits", async () => {
  const f = await fixture(true, true);
  try {
    expect(f.grandchild.error).toBeUndefined();
    expect(f.grandchild.owner.group).toBe(f.grandchild.pid);
    expect((await readdir(join(f.root, "server-groups"))).sort()).toEqual([`${f.child.pid}.json`, `${f.grandchild.pid}.json`].sort());
    f.p.kill("SIGKILL"); await f.p.exited;
    await expect(requireRepairGroupsStopped(f.root, f.owner)).rejects.toThrow("still live");
    await stopRepairServerGroups(f.root, f.owner);
    await expect(requireRepairGroupsStopped(f.root, f.owner)).resolves.toBeUndefined();
  } finally { await f.close(); }
});

test("closed admission cannot accept another server", async () => {
  const f = await fixture();
  try {
    const { claimOperation } = await import("./operation-intent.ts");
    await claimOperation(join(f.root, "server-groups/closing.json"), { root: f.owner });
    await expect(registerRepairServer(f.root, f.owner)).rejects.toThrow("admission is closed");
  } finally { await f.close(); }
});
