import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { nodeSandbox } from "./node-sandbox.ts";
import { readProcessText } from "./process-output.ts";

test.skipIf(process.platform !== "darwin")(
  "the sandboxed node starts through a symlink to it, and reads under /Users stay denied",
  async () => {
    const node = process.env.KGR_NODE_BIN ?? Bun.which("node");
    if (!node) throw new Error("Node is required for the sandbox check");
    // A checkout usually lives under /Users, where the profile denies reading the link.
    const dir = await mkdtemp(join(import.meta.dir, ".node-link-"));
    try {
      const link = join(dir, "node");
      await symlink(node, link);
      const p = Bun.spawn(
        [
          ...(await nodeSandbox(link)),
          "-e",
          `process.stdout.write("started");require("fs").readdirSync("/Users")`,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        readProcessText(p.stdout),
        readProcessText(p.stderr),
        p.exited,
      ]);
      expect(stdout).toBe("started");
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("EPERM");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
