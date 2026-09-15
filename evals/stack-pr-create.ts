import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { command } from "./github-live.ts";
import { fixtureCommand } from "./github-fixture-target.ts";
import { atomicJson } from "./issue-receipt.ts";
import { claimOperation } from "./operation-intent.ts";
import type { StackPublicationContext } from "./stack-publication.ts";

// Creation has one fixed, admitted dependency and never links or retargets a PR.
// The coordinator owns the phase and reconciles an uncertain response.
export async function createDraftPR(c: StackPublicationContext, head: string, run: typeof command = command) {
  const parent = c.prefix.at(-1);
  if (!/^frostney\/kgr-eval-\d{8}-[a-z0-9-]+$/.test(c.repository) || !parent || !/^[0-9a-f]{40}$/.test(head))
    throw Error("Invalid admitted PR creation");
  run = fixtureCommand(c.repository, run);
  const gitdir = await run(["git", "rev-parse", "--absolute-git-dir"], c.directory);
  const message = await run(["git", "show", "-s", "--format=%s%n%b", head], c.directory);
  const [title, ...description] = message.split("\n");
  if (!title?.trim()) throw Error("PR creation requires the admitted commit subject");
  const directory = join(gitdir, "kgr-stack-pr-creations", crypto.randomUUID());
  await mkdir(directory, { recursive: true });
  const argv = ["gh", "api", `repos/${c.repository}/pulls`, "--method", "POST", "--input", "-",
    "--hostname", "github.com", "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2026-03-10"];
  const body = { head: c.branch, base: parent.branch, draft: true, title, body: description.join("\n").trim() };
  if (!await claimOperation(join(directory, "request.json"), { context: c, head, pid: process.pid, command: argv, body }))
    throw Error("Creation receipt already exists");
  try {
    const response = JSON.parse(await run(argv, c.directory, JSON.stringify(body)));
    if (!Number.isSafeInteger(response.number) || response.number <= 0 || response.head?.sha !== head || response.head?.ref !== c.branch ||
        response.head?.repo?.id !== c.repositoryId || response.base?.repo?.id !== c.repositoryId ||
        response.base?.ref !== parent.branch || response.base?.sha !== parent.head || response.draft !== true || response.state !== "open")
      throw Error("PR creation response differs; reconcile GitHub before continuing");
    await atomicJson(join(directory, "result.json"), { responseVerified: true, pr: response.number, head, baseRef: parent.branch, baseHead: parent.head });
  } catch (error) {
    await atomicJson(join(directory, "result.json"), { responseVerified: false, error: String(error), reconciliationRequired: true });
    throw error;
  }
}
