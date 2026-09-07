import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDraftPR } from "./stack-pr-create.ts";
import type { StackPublicationContext } from "./stack-publication.ts";

test("branch-only creation uses the admitted base and commit without linking or retargeting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kgr-create-pr-"));
  try {
    const c = { repository: "frostney/kgr-eval-20260906-create", repositoryId: 42, directory, branch: "codex/eval-fix",
      prefix: [{ branch: "codex/eval-parent", head: "b".repeat(40) }] } as StackPublicationContext;
    const writes: { argv: string[]; body: any }[] = [];
    await createDraftPR(c, "a".repeat(40), async (argv, _cwd, input, environment) => {
      expect(environment?.GH_HOST).toBe("github.com");
      expect(environment?.GH_REPO).toBe(`github.com/${c.repository}`);
      if (argv[0] === "git") return argv[1] === "rev-parse" ? directory : "fix: preserve values\nKGR-Operation: fixture";
      writes.push({ argv, body: JSON.parse(input!) });
      return JSON.stringify({ number: 7, head: { ref: c.branch, sha: "a".repeat(40), repo: { id: 42 } },
        base: { ref: c.prefix[0]!.branch, sha: c.prefix[0]!.head, repo: { id: 42 } }, draft: true, state: "open" });
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.argv).toContain("--hostname");
    expect(writes[0]!.argv.slice(0, 5)).toEqual(["gh", "api", `repos/${c.repository}/pulls`, "--method", "POST"]);
    expect(writes[0]!.body).toEqual({ head: c.branch, base: c.prefix[0]!.branch, draft: true, title: "fix: preserve values", body: "KGR-Operation: fixture" });
    const entries = await readdir(join(directory, "kgr-stack-pr-creations"));
    expect(await Bun.file(join(directory, "kgr-stack-pr-creations", entries[0]!, "result.json")).json()).toMatchObject({ responseVerified: true, pr: 7 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("uncertain creation preserves the request and never retries or changes its base", async () => {
  for (const response of [Error("connection lost after acceptance"), { number: 7, head: { sha: "f".repeat(40) } }]) {
    const directory = await mkdtemp(join(tmpdir(), "kgr-create-pr-error-"));
    try {
      const c = { repository: "frostney/kgr-eval-20260906-create", repositoryId: 42, directory, branch: "codex/eval-fix",
        prefix: [{ branch: "codex/eval-parent", head: "b".repeat(40) }] } as StackPublicationContext;
      let writes = 0;
      await expect(createDraftPR(c, "a".repeat(40), async (argv) => {
        if (argv[0] === "git") return argv[1] === "rev-parse" ? directory : "fix: preserve values";
        writes++; if (response instanceof Error) throw response; return JSON.stringify(response);
      })).rejects.toThrow();
      expect(writes).toBe(1);
      const entries = await readdir(join(directory, "kgr-stack-pr-creations")), root = join(directory, "kgr-stack-pr-creations", entries[0]!);
      expect(await Bun.file(join(root, "request.json")).exists()).toBe(true);
      expect(await Bun.file(join(root, "result.json")).json()).toMatchObject({ responseVerified: false, reconciliationRequired: true });
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});
