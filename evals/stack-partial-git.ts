// Controlled fixture interception only. Credential commands pass through without
// inspection, capture or argument logging. Only a successful push is inspected.
import { atomicJson } from "./issue-receipt.ts";
import { command } from "./github-live.ts";
import { dirname, join } from "node:path";
const config = await Bun.file(Bun.argv[2]!).json(), args = Bun.argv.slice(3);
const child = Bun.spawn([config.realGit, ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
const code = await child.exited;
if (code === 0 && args.length === 1 && args[0] === "--version")
  await atomicJson(join(dirname(config.boundaryPath), "interception-probe.json"), { wrapperPid: process.pid, gitExitCode: code });
if (code === 0 && args[0] === "push") {
  const current = await command([config.realGit, "ls-remote", "--heads", "origin", `refs/heads/${config.context.branch}`], config.context.directory);
  if (current === `${config.head}\trefs/heads/${config.context.branch}`) {
    await atomicJson(config.boundaryPath, { phase: "branch-pushed", head: config.head, branch: config.context.branch,
      wrapperPid: process.pid, gitExitCode: code, at: new Date().toISOString() });
    // The native submit command cannot proceed to PR creation until its git
    // child returns. The controller kills the owned group at this boundary.
    setInterval(() => {}, 1000); await new Promise(() => {});
  }
}
process.exit(code);
