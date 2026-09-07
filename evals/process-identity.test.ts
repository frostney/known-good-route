import { test, expect } from "bun:test";
import {
  processIdentity,
  waitForProcessesStopped,
} from "./process-identity.ts";
import {
  waitForLifecycleEnd,
  requireIssueProcedure,
  emptyIssueLedger,
} from "./issue-live.ts";
test("restart admission waits for the owned process to end, not just an observation timeout", async () => {
  const child = Bun.spawn(
    [process.execPath, "-e", "setInterval(()=>{},1000)"],
    { stdout: "ignore", stderr: "ignore" },
  );
  try {
    const identity = await processIdentity(child.pid);
    await expect(waitForProcessesStopped([identity], 10)).rejects.toThrow(
      "still live",
    );
    expect(child.exitCode).toBeNull();
    child.kill("SIGTERM");
    await child.exited;
    await expect(
      waitForProcessesStopped([identity], 1000),
    ).resolves.toBeUndefined();
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
});
test("an unrelated process occupying a PID cannot keep an older identity alive", async () => {
  const self = await processIdentity(process.pid);
  await expect(
    waitForProcessesStopped(
      [{ ...self, birth: "different original birth" }],
      10,
    ),
  ).resolves.toBeUndefined();
});
test("pending worker operation ends when its owning transport ends", async () => {
  const lifecycle = new AbortController();
  const pending = waitForLifecycleEnd(lifecycle.signal);
  lifecycle.abort();
  await expect(pending).rejects.toThrow("lifecycle ended");
  await expect(waitForLifecycleEnd(lifecycle.signal)).rejects.toThrow(
    "lifecycle ended",
  );
});

test("a saved worker procedure cannot authorize a fresh coordinator's workflow operations", async () => {
  const ledger = emptyIssueLedger();
  ledger.loadedSkills.push("create-issue");
  const rejected: unknown[] = [];
  const record = async (action: string, data: unknown) => {
    rejected.push({ action, data });
  };
  await expect(
    requireIssueProcedure("parent", ledger, "reconcileIssue", record),
  ).rejects.toThrow("Load milestone-rush");
  expect(rejected).toEqual([
    {
      action: "procedureRejected",
      data: { action: "reconcileIssue", workflow: "milestone-rush" },
    },
  ]);
  ledger.loadedSkills.push("milestone-rush");
  await expect(
    requireIssueProcedure("parent", ledger, "reconcileIssue", record),
  ).resolves.toBeUndefined();
  expect(rejected.length).toBe(1);
  const child = emptyIssueLedger();
  child.loadedSkills.push("milestone-rush");
  await expect(
    requireIssueProcedure("worker", child, "createIssue", record),
  ).rejects.toThrow("Load create-issue");
});
