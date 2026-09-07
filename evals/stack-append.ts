import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { command } from "./github-live.ts";
import { fixtureCommand } from "./github-fixture-target.ts";
import { atomicJson } from "./issue-receipt.ts";
import { claimOperation } from "./operation-intent.ts";
import type { StackPublicationContext } from "./stack-publication.ts";

// The official endpoint validates the PR base against the current native top.
// Unlike gh stack link, this operation cannot retarget a PR before appending it.
// The caller owns the phase intent and must reconcile every uncertain response.
export async function appendExistingPR(c: StackPublicationContext, pr: number, head: string,
  run: typeof command = command) {
  if (!/^frostney\/kgr-eval-\d{8}-[a-z0-9-]+$/.test(c.repository) || !Number.isSafeInteger(c.stack) || c.stack <= 0 ||
      !Number.isSafeInteger(pr) || pr <= 0 || !/^[0-9a-f]{40}$/.test(head)) throw Error("Invalid admitted stack append");
  run = fixtureCommand(c.repository, run);
  const gitdir = await run(["git", "rev-parse", "--absolute-git-dir"], c.directory);
  const directory = join(gitdir, "kgr-stack-appends", crypto.randomUUID());
  await mkdir(directory, { recursive: true });
  const argv = ["gh", "api", `repos/${c.repository}/stacks/${c.stack}/add`, "--method", "POST", "--input", "-",
    "--hostname", "github.com", "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2026-03-10"];
  const body = { pull_requests: [pr] };
  if (!await claimOperation(join(directory, "request.json"), { context: c, head, pr, pid: process.pid, command: argv, body }))
    throw Error("Append receipt already exists");
  try {
    const response = JSON.parse(await run(argv, c.directory, JSON.stringify(body)));
    if (response.id !== c.stackId || response.number !== c.stack || !Array.isArray(response.pull_requests) ||
        response.pull_requests.at(-1)?.number !== pr) throw Error("Append response identity differs; reconcile GitHub before continuing");
    await atomicJson(join(directory, "result.json"), { responseVerified: true, stackId: response.id, stack: response.number, pr });
  } catch (error) {
    await atomicJson(join(directory, "result.json"), { responseVerified: false, error: String(error), reconciliationRequired: true });
    throw error;
  }
}
