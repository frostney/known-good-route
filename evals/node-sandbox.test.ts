import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { nodeSandbox } from "./node-sandbox.ts";
import { readProcessText } from "./process-output.ts";

test.skipIf(process.platform !== "darwin")(
  "the sandboxed node starts wherever it is installed, and other reads under /Users stay denied",
  async () => {
    const node = process.env.KGR_NODE_BIN ?? Bun.which("node");
    if (!node) throw new Error("Node is required for the sandbox check");
    const p = Bun.spawn(
      [
        ...(await nodeSandbox(node)),
        "-e",
        `process.stdout.write("started");require("fs").readdirSync(${JSON.stringify(homedir())})`,
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
  },
);
