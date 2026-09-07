import { observeProcess, processIdentity, type ProcessIdentity } from "./process-identity.ts";
import { readProcessText } from "./process-output.ts";

export interface OwnedProcessGroup { leader: ProcessIdentity; group: number }
export async function groupProcesses(group: number) {
  if (!Number.isSafeInteger(group) || group <= 0) throw Error("Invalid process group");
  const p = Bun.spawn(["ps", "-axo", "pid=,pgid=,stat="], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([readProcessText(p.stdout), readProcessText(p.stderr), p.exited]);
  if (code || err.trim()) throw Error("Cannot observe process groups");
  return out.trim().split("\n").map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) throw Error("Unrecognized process group listing");
    return { pid: Number(match[1]), group: Number(match[2]), terminal: match[3]!.startsWith("Z") };
  }).filter(row => row.group === group && !row.terminal);
}
export async function ownedProcessGroup(pid: number): Promise<OwnedProcessGroup> {
  const leader = await processIdentity(pid);
  if (!(await groupProcesses(pid)).some(p => p.pid === pid)) throw Error("Native process did not start in its own group");
  return { leader, group: pid };
}
export async function requireGroupStopped(owner: OwnedProcessGroup) {
  if (owner.group !== owner.leader.pid || !owner.leader.birth) throw Error("Unverifiable process group ownership");
  const leader = await observeProcess(owner.leader.pid);
  if (leader && !leader.terminal && leader.birth === owner.leader.birth) throw Error("Native coordinator is still live; do not resume");
  const remaining = await groupProcesses(owner.group);
  if (remaining.length) throw Error(`Owned group has live or reused processes (${remaining.map(p => p.pid).join(",")}); do not resume`);
}
