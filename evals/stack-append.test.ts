import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendExistingPR } from "./stack-append.ts";
import type { StackPublicationContext } from "./stack-publication.ts";

test("detached append sends only the admitted PR to the native endpoint and records acceptance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kgr-append-"));
  try {
    const context = { repository: "frostney/kgr-eval-20260906-append", stack: 3, stackId: 42, directory } as StackPublicationContext;
    const calls: { argv: string[]; input: string | undefined }[] = [];
    await appendExistingPR(context, 7, "a".repeat(40), async (argv, _cwd, input, environment) => {
      expect(environment?.GH_HOST).toBe("github.com");
      expect(environment?.GH_REPO).toBe(`github.com/${context.repository}`);
      if (argv[0] === "git") return directory;
      calls.push({ argv, input });
      return JSON.stringify({ id: 42, number: 3, pull_requests: [{ number: 7 }], irrelevant: "not retained" });
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv).toContain("--hostname");
    expect(calls[0]!.argv.slice(0, 7)).toEqual(["gh", "api", "repos/frostney/kgr-eval-20260906-append/stacks/3/add", "--method", "POST", "--input", "-"]);
    expect(JSON.parse(calls[0]!.input!)).toEqual({ pull_requests: [7] });
    const entries = await readdir(join(directory, "kgr-stack-appends"));
    const receipt = await Bun.file(join(directory, "kgr-stack-appends", entries[0]!, "result.json")).json();
    expect(receipt).toEqual({ responseVerified: true, stackId: 42, stack: 3, pr: 7 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("conflict or uncertain append responses never trigger retargeting or a second write", async () => {
  for (const response of [Error("HTTP 422: base does not match current top"), Error("connection lost after acceptance"), { id: 99, number: 3, pull_requests: [{ number: 7 }] }]) {
    const directory = await mkdtemp(join(tmpdir(), "kgr-append-failure-"));
    try {
      const context = { repository: "frostney/kgr-eval-20260906-append", stack: 3, stackId: 42, directory } as StackPublicationContext;
      let writes = 0;
      await expect(appendExistingPR(context, 7, "a".repeat(40), async (argv) => {
        if (argv[0] === "git") return directory;
        writes++;
        expect(argv).toContain("repos/frostney/kgr-eval-20260906-append/stacks/3/add");
        if (response instanceof Error) throw response;
        return JSON.stringify(response);
      })).rejects.toThrow();
      expect(writes).toBe(1);
      const entries = await readdir(join(directory, "kgr-stack-appends"));
      const evidence = join(directory, "kgr-stack-appends", entries[0]!);
      expect(await Bun.file(join(evidence, "request.json")).exists()).toBe(true);
      expect(await Bun.file(join(evidence, "result.json")).json()).toMatchObject({ responseVerified: false, reconciliationRequired: true });
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});
