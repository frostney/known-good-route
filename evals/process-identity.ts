import { readProcessText } from "./process-output.ts";
export interface ProcessIdentity {
  pid: number;
  birth: string;
}
export async function observeProcess(
  pid: number,
): Promise<(ProcessIdentity & { terminal: boolean }) | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error("Invalid owned process PID");
  const p = Bun.spawn(
    ["ps", "-p", String(pid), "-o", "lstart=", "-o", "stat="],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, LC_ALL: "C" } },
  );
  const [out, err, code] = await Promise.all([
    readProcessText(p.stdout),
    readProcessText(p.stderr),
    p.exited,
  ]);
  if (code === 1 && !out.trim() && !err.trim()) return undefined;
  if (code) throw new Error("Cannot observe owned process state");
  const match = /^(.*\d{4})\s+(\S+)$/.exec(out.trim());
  if (!match)
    throw new Error("Unrecognized process identity; preserve the process");
  return {
    pid,
    birth: match[1]!.replace(/\s+/g, " "),
    terminal: match[2]!.startsWith("Z"),
  };
}
export async function processIdentity(pid: number): Promise<ProcessIdentity> {
  const observed = await observeProcess(pid);
  if (!observed || observed.terminal)
    throw new Error("Process ended before its ownership was recorded");
  return { pid, birth: observed.birth };
}
export async function waitForProcessesStopped(
  identities: ProcessIdentity[],
  timeoutMs = 10000,
) {
  const deadline = Date.now() + timeoutMs;
  let remaining: ProcessIdentity[] = identities;
  while (remaining.length) {
    const observed = await Promise.all(
      remaining.map((p) => observeProcess(p.pid)),
    );
    remaining = remaining.filter(
      (p, i) =>
        observed[i] && !observed[i]!.terminal && observed[i]!.birth === p.birth,
    );
    if (!remaining.length) return;
    if (Date.now() >= deadline)
      throw new Error(
        `Owned processes still live: ${remaining.map((p) => p.pid).join(",")}; do not restart`,
      );
    await new Promise((r) => setTimeout(r, 100));
  }
}
