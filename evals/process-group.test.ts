import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ownedProcessGroup, requireGroupStopped, groupProcesses } from "./process-group.ts";

test("resume rejects a live native group and admits a stopped isolated group", async () => {
  const p = Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)"], { detached: true, stdout: "ignore", stderr: "ignore" });
  try {
    const group = await ownedProcessGroup(p.pid);
    await expect(requireGroupStopped(group)).rejects.toThrow("still live");
    process.kill(-p.pid, "SIGKILL"); await p.exited;
    await expect(requireGroupStopped(group)).resolves.toBeUndefined();
  } finally {
    try { process.kill(-p.pid, "SIGKILL"); } catch (e: any) { if (e.code !== "ESRCH") throw e; }
    await p.exited;
  }
});
test("leader death does not admit restart while an orphan remains in its group", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kgr-group-")), file = join(dir, "child.json");
  const code = `const c=Bun.spawn([process.execPath,"-e","setInterval(()=>{},1000)"],{stdout:"ignore",stderr:"ignore"}); await Bun.write(${JSON.stringify(file)},JSON.stringify({pid:c.pid}));setInterval(()=>{},1000)`;
  const p = Bun.spawn([process.execPath, "-e", code], { detached: true, stdout: "ignore", stderr: "ignore" });
  try {
    const group = await ownedProcessGroup(p.pid);
    const deadline = Date.now() + 5000;
    while (!await Bun.file(file).exists()) { if (Date.now() >= deadline) throw Error("Child registration timed out"); await Bun.sleep(10); }
    const child = await Bun.file(file).json();
    p.kill("SIGKILL"); await p.exited;
    expect((await groupProcesses(group.group)).some(v => v.pid === child.pid)).toBe(true);
    await expect(requireGroupStopped(group)).rejects.toThrow("group has live");
    process.kill(-group.group, "SIGKILL");
    const stop = Date.now() + 5000;
    while ((await groupProcesses(group.group)).length) { if (Date.now() >= stop) throw Error("Group did not stop"); await Bun.sleep(10); }
    await expect(requireGroupStopped(group)).resolves.toBeUndefined();
  } finally {
    try { process.kill(-p.pid, "SIGKILL"); } catch (e: any) { if (e.code !== "ESRCH") throw e; }
    await p.exited; await rm(dir, { recursive: true, force: true });
  }
});
