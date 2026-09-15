import { mkdir } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { command } from "./github-live.ts";
import { atomicJson } from "./issue-receipt.ts";
import {
  baseFiles,
  storeFiles,
  batchFiles,
  stackContract,
  runPipeline,
  pipelineProbes,
} from "./stack-program.ts";
if (
  process.env.CI ||
  process.env.GITHUB_ACTIONS ||
  !Bun.argv.includes("--execute")
)
  throw Error("Stack setup requires explicit local --execute");
const arg = (name: string) => {
  const i = Bun.argv.indexOf(name);
  return i < 0 ? undefined : Bun.argv[i + 1];
};
const repository = arg("--repository");
if (
  !repository ||
  !/^frostney\/kgr-eval-\d{8}-[a-z0-9-]+$/.test(repository) ||
  !arg("--output")
)
  throw Error("Provide disposable --repository and fresh --output");
const node = process.env.KGR_NODE_BIN ?? Bun.which("node");
if (
  process.platform !== "darwin" ||
  !node ||
  !/^v24\./.test(await command([node, "--version"]))
)
  throw Error(
    "Stack fixture execution requires macOS sandbox-exec and selected Node 24 before creating remote artifacts",
  );
const ghStackVersion = await command(["gh", "stack", "--version"]);
const output = resolve(arg("--output")!);
await mkdir(output);
const directory = join(output, "repository");
await mkdir(directory);
const git = (...args: string[]) => command(["git", ...args], directory);
const gh = (...args: string[]) => command(["gh", ...args], directory);
if ((await gh("api", "user", "--jq", ".login")) !== "frostney")
  throw Error("Unexpected authenticated owner");
const writeFiles = async (files: Record<string, string>) => {
  for (const [file, text] of Object.entries(files)) {
    await mkdir(dirname(join(directory, file)), { recursive: true });
    await Bun.write(join(directory, file), text);
  }
};
const commit = async (message: string, files: string[]) => {
  await git("add", "--", ...files);
  await git("commit", "-m", message);
  if (await git("status", "--porcelain"))
    throw Error("Uncommitted fixture changes");
};
let inventory: any;
if (arg("--inventory")) {
  inventory = await Bun.file(resolve(arg("--inventory")!)).json();
  if (inventory.repository !== repository)
    throw Error("Inventory repository mismatch");
  await gh("repo", "clone", repository, directory);
} else {
  await git("init", "--initial-branch=main");
  await writeFiles(baseFiles);
  await commit(
    "test: define atomic record pipeline contract",
    Object.keys(baseFiles),
  );
  await gh(
    "repo",
    "create",
    repository,
    "--private",
    "--source",
    directory,
    "--remote",
    "origin",
    "--push",
  );
  const remote = JSON.parse(await gh("api", `repos/${repository}`));
  inventory = {
    repository,
    repositoryId: remote.id,
    url: remote.html_url,
    base: await git("rev-parse", "HEAD"),
    defaultBranch: remote.default_branch,
    createdAt: new Date().toISOString(),
  };
  await atomicJson(join(output, "repository.json"), inventory);
}
const remote = JSON.parse(await gh("api", `repos/${repository}`));
if (
  remote.id !== inventory.repositoryId ||
  !remote.private ||
  remote.full_name !== repository
)
  throw Error("Repository identity mismatch");
if (await git("status", "--porcelain")) throw Error("Dirty fixture checkout");
const defaultBranch = remote.default_branch;
await git("fetch", "origin", defaultBranch);
const base = await git("rev-parse", `origin/${defaultBranch}`);
if (base !== inventory.base) throw Error("Unexpected changed remote default");
await git("switch", defaultBranch);
await git("merge", "--ff-only", `origin/${defaultBranch}`);
const runId = crypto.randomUUID().slice(0, 8);
const branches = [
  `codex/eval-stack-${runId}-store`,
  `codex/eval-stack-${runId}-batch`,
];
await atomicJson(join(output, "plan.json"), {
  runId,
  repository,
  repositoryId: remote.id,
  base,
  defaultBranch,
  branches,
  contract: stackContract,
  ghStackVersion,
  createdAt: new Date().toISOString(),
});
await gh("stack", "init", "--base", defaultBranch, branches[0]!);
if ((await git("rev-parse", "HEAD")) !== base)
  throw Error("Stack initialized from stale trunk");
await writeFiles(storeFiles);
await commit(
  "feat: preserve JSON records through isolated reads",
  Object.keys(storeFiles),
);
await gh("stack", "add", branches[1]!);
await writeFiles(batchFiles);
await commit(
  "feat: execute atomic record batches through the CLI",
  Object.keys(batchFiles),
);
const visible = await runPipeline(directory, {}, node, true);
await atomicJson(join(output, "visible-tests.json"), visible);
if (!visible.passed) throw Error("Seeded stack must pass visible tests");
const observations = [];
for (const input of pipelineProbes)
  observations.push({ input, ...(await runPipeline(directory, input, node)) });
await atomicJson(join(output, "baseline-probes.json"), observations);
if (observations.every((o) => o.passed))
  throw Error("Baseline unexpectedly satisfies all host oracles");
const before = JSON.parse(await gh("stack", "view", "--json"));
const localHeads = await Promise.all(
  branches.map((branch) => git("rev-parse", branch)),
);
const leases = await git(
  "ls-remote",
  "--heads",
  "origin",
  ...branches.map((b) => `refs/heads/${b}`),
);
if (leases) throw Error("Fresh fixture branches already exist remotely");
await atomicJson(join(output, "before-submit.json"), {
  local: before,
  branches,
  localHeads,
  remoteHeads: [],
  clean: true,
  base,
});
await gh("stack", "submit", "--auto");
const local = JSON.parse(await gh("stack", "view", "--json"));
await atomicJson(join(output, "local-stack.json"), local);
const stacks = JSON.parse(await gh("api", `repos/${repository}/stacks`));
const candidates = [];
for (const candidate of stacks) {
  const raw = JSON.parse(
    await gh("api", `repos/${repository}/stacks/${candidate.number}`),
  );
  if (raw.pull_requests?.some((p: any) => branches.includes(p.head?.ref)))
    candidates.push(raw);
}
if (candidates.length !== 1)
  throw Error("Could not identify one authoritative native stack");
const stack = candidates[0];
if (
  stack.pull_requests.length !== 2 ||
  stack.pull_requests.some(
    (p: any, i: number) =>
      p.head.ref !== branches[i] || p.head.sha !== localHeads[i],
  )
)
  throw Error("Native stack order or heads differ");
for (let i = 0; i < stack.pull_requests.length; i++) {
  const pr = stack.pull_requests[i];
  const body = `## Claim\n\n${i === 0 ? "Provide an isolated record store that preserves all JSON values and exact string keys." : "Add validation, atomic batches and the JSON CLI on top of the record store."}\n\nThis is an explicitly authorized disposable evaluation fixture. Known seeded defects may remain despite the visible tests passing. Review against AGENTS.md and the integrated top; any fixes belong in new top layers, preserving these original heads.\n\n## Validation\n\nVisible integrated tests passed during fixture setup. Independent host CLI probes exposed behavior gaps, so this layer is not certified correct or merge-ready. No merge is authorized.\n`;
  const bodyFile = join(output, `pr-${pr.number}-body.md`);
  await Bun.write(bodyFile, body);
  await gh("pr", "edit", String(pr.number), "--body-file", bodyFile);
}
await atomicJson(join(output, "stack.json"), {
  ...inventory,
  runId,
  directory,
  branches,
  stackNumber: stack.number,
  stack,
  localHeads,
  nodeBinary: node,
  createdAt: new Date().toISOString(),
});
console.log(
  JSON.stringify(
    {
      repository,
      stack: stack.number,
      prs: stack.pull_requests.map((p: any) => ({
        number: p.number,
        url: p.html_url,
        head: p.head.sha,
      })),
      evidence: output,
    },
    null,
    2,
  ),
);
