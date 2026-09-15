// This fixture shim pauses only the stack CLI's branch-tracking fetch. It does
// not inspect credential commands, arguments or output.
import { join } from "node:path";
import { atomicJson } from "./issue-receipt.ts";
import { command } from "./github-live.ts";
const config = await Bun.file(Bun.argv[2]!).json(), args = Bun.argv.slice(3);
const member = config.context.prefix[0], boundary = join(config.evidence, "before-fetch.json");
if (args[0] === "fetch" && args[1] === "origin" &&
    args.includes(`+refs/heads/${member.branch}:refs/remotes/origin/${member.branch}`) && !await Bun.file(boundary).exists()) {
  const tracking = await command([config.realGit, "rev-parse", `refs/remotes/origin/${member.branch}`], config.context.directory);
  await atomicJson(boundary, { wrapperPid: process.pid, beforeTracking: tracking, branch: member.branch, at: new Date().toISOString() });
  const deadline = Date.now() + 120000;
  while (!await Bun.file(join(config.evidence, "release-fetch.json")).exists()) {
    if (Date.now() >= deadline) throw Error("Controlled fetch boundary was not released");
    await Bun.sleep(50);
  }
}
const child = Bun.spawn([config.realGit, ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
process.exit(await child.exited);
