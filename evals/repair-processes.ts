import { lstat, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { issueDigest } from "./issue-receipt.ts";
import { claimOperation, readOperationIntent } from "./operation-intent.ts";
import { command } from "./github-live.ts";
import { observeProcess } from "./process-identity.ts";
import { groupProcesses, ownedProcessGroup, requireGroupStopped, type OwnedProcessGroup } from "./process-group.ts";

const directory = (attempt: string) => join(attempt, "server-groups");
const closing = (attempt: string) => join(directory(attempt), "closing.json");
export async function initializeRepairGroups(attempt: string) { await mkdir(directory(attempt)); }
async function registry(attempt: string) {
  const meta = await lstat(directory(attempt));
  if (!meta.isDirectory() || meta.isSymbolicLink()) throw Error("Repair server group registry is not a real directory");
}
async function lineage(root: OwnedProcessGroup) {
  const output = await command(["ps", "-axo", "pid=,ppid=,pgid=,lstart=,stat="], undefined, undefined, { ...process.env, LC_ALL: "C" });
  const rows = new Map(output.split("\n").map(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*\d{4})\s+(\S+)\s*$/.exec(line);
    if (!m) throw Error("Cannot inspect server ancestry");
    return [Number(m[1]), { pid: Number(m[1]), parent: Number(m[2]), group: Number(m[3]), birth: m[4]!.replace(/\s+/g, " "), terminal: m[5]!.startsWith("Z") }] as const;
  }));
  const chain: Array<NonNullable<ReturnType<typeof rows.get>>> = []; let pid = process.pid;
  for (let i = 0; i < 64; i++) {
    const row = rows.get(pid);
    if (!row || row.terminal || chain.some(p => p.pid === pid)) break;
    chain.push(row);
    if (pid === root.leader.pid && row.birth === root.leader.birth && row.group === root.group) return chain;
    pid = row.parent;
  }
  throw Error("Repair server is not a live descendant of its admitted native owner");
}

// Codex starts MCP servers in distinct process groups. Register only a live,
// identity-checked descendant before exposing any tools. Recheck after the
// durable claim: a server registering after root exit must never serve writes.
export async function registerRepairServer(attempt: string, root: OwnedProcessGroup): Promise<OwnedProcessGroup> {
  await registry(attempt);
  if (await readOperationIntent(closing(attempt)) !== undefined) throw Error("Repair process admission is closed");
  if (issueDigest(await ownedProcessGroup(root.group)) !== issueDigest(root)) throw Error("Native owner identity changed");
  const before = await lineage(root), group = before[0]!.group;
  if (!before.some(p => p.pid === group)) throw Error("Server group leader is outside the admitted ancestry");
  const owner = await ownedProcessGroup(group);
  if (group !== root.group) {
    const path = join(directory(attempt), `${group}.json`);
    const request = { root, owner };
    if (!await claimOperation(path, request)) {
      const prior: any = await readOperationIntent(path);
      if (issueDigest(prior?.root) !== issueDigest(root) || issueDigest(prior?.owner) !== issueDigest(owner))
        throw Error("Server group registration belongs to another owner");
    }
  }
  if (issueDigest(before) !== issueDigest(await lineage(root)) ||
      issueDigest(await ownedProcessGroup(root.group)) !== issueDigest(root) ||
      await readOperationIntent(closing(attempt)) !== undefined) throw Error("Server ancestry or admission changed while registering");
  return owner;
}

async function childOwners(attempt: string, root: OwnedProcessGroup) {
  await registry(attempt);
  const owners: OwnedProcessGroup[] = [];
  for (const name of await readdir(directory(attempt))) {
    if (name === "closing.json") continue;
    if (!/^[1-9]\d*\.json$/.test(name)) throw Error("Unexpected server group ownership entry");
    const path = join(directory(attempt), name), meta = await lstat(path);
    if (!meta.isFile() || meta.isSymbolicLink()) throw Error("Server group ownership is not a regular file");
    const saved: any = await readOperationIntent(path), owner = saved?.owner;
    if (issueDigest(saved?.root) !== issueDigest(root) || !owner || owner.group !== owner.leader?.pid ||
        String(owner.group) + ".json" !== name || !owner.leader.birth || owner.group === root.group)
      throw Error("Server group ownership differs from admitted native root");
    owners.push(owner);
  }
  return owners;
}
export async function requireRepairGroupsStopped(attempt: string, root: OwnedProcessGroup) {
  await requireGroupStopped(root);
  for (const owner of await childOwners(attempt, root)) await requireGroupStopped(owner);
}

// Called once the native root has exited, including cancellation. A live server
// leader can safely identify its group for termination. Unknown/reused leaders
// or orphan-only groups block recovery instead of authorizing a broad signal.
export async function stopRepairServerGroups(attempt: string, root: OwnedProcessGroup) {
  await requireGroupStopped(root);
  await registry(attempt);
  await claimOperation(closing(attempt), { root });
  const owners = await childOwners(attempt, root);
  for (const owner of owners) {
    if (!(await groupProcesses(owner.group)).length) continue;
    const current = await observeProcess(owner.leader.pid);
    if (!current || current.terminal || current.birth !== owner.leader.birth) throw Error("Server group has an unverified live or orphaned process; preserve it");
    try { process.kill(-owner.group, "SIGTERM"); }
    catch (error: any) { if (error.code !== "ESRCH") throw error; }
  }
  const deadline = Date.now() + 5000;
  for (const owner of owners) {
    while ((await groupProcesses(owner.group)).length) {
      if (Date.now() >= deadline) throw Error("Server groups did not stop after termination; do not resume");
      await Bun.sleep(25);
    }
  }
  await requireRepairGroupsStopped(attempt, root);
}
