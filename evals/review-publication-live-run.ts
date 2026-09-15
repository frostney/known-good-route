import { appendFile, mkdir, open } from "node:fs/promises";
import { resolve, join } from "node:path";
import { command, digest } from "./github-live.ts";
import { atomicJson } from "./issue-receipt.ts";
import { publishReview, type ReviewForge, type ReviewRequest, reviewOperationMarker } from "./review-publication.ts";

if (process.env.CI || process.env.GITHUB_ACTIONS || !Bun.argv.includes("--execute")) throw Error("Live review recovery requires explicit local --execute");
const arg = (name: string) => { const i = Bun.argv.indexOf(name); return i < 0 ? undefined : Bun.argv[i + 1]; };
const repository = "frostney/kgr-eval-20260906-native-stack", repositoryId = 1358673926, pr = 2;
const head = "a053acc9ffb0f2d7294e0f6e092121c4d4db08a8";
const api = async (path: string, body?: unknown) => JSON.parse(await command(["gh", "api", path,
  ...(body ? ["--method", "POST", "--input", "-"] : [])], undefined, body ? JSON.stringify(body) : undefined));
const pages = async (path: string) => {
  const rows = JSON.parse(await command(["gh", "api", path + "?per_page=100", "--paginate", "--slurp"]));
  if (!Array.isArray(rows) || rows.some(p => !Array.isArray(p))) throw Error("Incomplete page transport");
  return rows.flat();
};
const endpoint = `repos/${repository}/pulls/${pr}`;
const guard = async () => {
  const repo = await api(`repos/${repository}`), pull = await api(endpoint), user = await api("user");
  if (repo.id !== repositoryId || repo.full_name !== repository || !repo.private || user.login !== "frostney" ||
      pull.head.sha !== head || !pull.draft || pull.state !== "open" || pull.merged) throw Error("Live negative fixture identity or head drifted");
};
const forge = (directory: string): ReviewForge => ({
  identity: () => api(`repos/${repository}`), actor: async () => (await api("user")).login,
  head: async () => (await api(endpoint)).head.sha,
  list: () => pages(endpoint + "/reviews"), get: id => api(endpoint + `/reviews/${id}`),
  comments: id => pages(endpoint + `/reviews/${id}/comments`), comment: id => api(`repos/${repository}/pulls/comments/${id}`),
  create: async body => {
    await guard();
    await appendFile(join(directory, "post-attempts.jsonl"), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + "\n");
    return api(endpoint + "/reviews", body);
  },
});
if (arg("--worker")) {
  const directory = resolve(arg("--worker")!);
  const request = await Bun.file(join(directory, "request.json")).json();
  const kill = async () => {
    // fsync the boundary receipt before the actual SIGKILL. No normal finally
    // cleanup or successful tool return can execute after this boundary.
    const f = await open(join(directory, `boundary-${process.pid}.json`), "wx", 0o600);
    try { await f.writeFile(JSON.stringify({ boundary: arg("--boundary"), pid: process.pid })); await f.sync(); }
    finally { await f.close(); }
    process.kill(process.pid, "SIGKILL");
    await new Promise(() => {});
  };
  const result = await publishReview(request, forge(directory), join(directory, "intent.json"),
    arg("--boundary") === "after-claim" ? { afterClaim: kill } : arg("--boundary") === "after-accepted" ? { afterAccepted: kill } : {});
  await atomicJson(join(directory, `worker-${process.pid}.json`), result);
} else {
  if (!arg("--output")) throw Error("Supply fresh --output");
  const output = resolve(arg("--output")!); await mkdir(output); await guard();
  const runId = crypto.randomUUID();
  await atomicJson(join(output, "plan.json"), { repository, repositoryId, pr, head, runId,
    purpose: "Deterministic publication interruption and concurrency on the preserved negative fixture. These labelled synthetic reviews are not independent findings or provider verdicts.",
    mutations: "At most two COMMENT reviews with one inline comment each. No source, topology, readiness or thread resolution changes.",
    sourceHashes: Object.fromEntries(await Promise.all(["review-publication.ts", "review-publication-live-run.ts", "issue-receipt.ts"].map(async name =>
      [name, digest(await Bun.file(join(import.meta.dir, name)).text())]))), createdAt: new Date().toISOString() });
  const results = [];
  for (const boundary of ["after-claim", "after-accepted", "concurrent"]) {
    const directory = join(output, boundary); await mkdir(directory);
    const note = "\n\n> [!NOTE]\n> Created on behalf of @frostney using GPT-6 Astra.";
    const request: ReviewRequest = { repository, repositoryId, pr, head, actor: "frostney", operation: `${runId}-${boundary}`,
      attempt: `synthetic-${runId}-${boundary}`, revision: head, model: "GPT-6 Astra (deterministic transport fixture; no native reviewer)",
      body: `Synthetic publication recovery fixture (${boundary}). Tests interruption and duplicate prevention only; this is not an independent review or completion verdict.${note}`,
      comments: [{ path: "src/batch.mjs", line: 8, side: "RIGHT",
        body: `Synthetic recovery receipt (${boundary}). This comment is an exact-body/location test input. The existing partial-write defect remains intentionally unfixed; no resolution is requested.${note}` }] };
    await atomicJson(join(directory, "request.json"), request);
    const workers = Array.from({ length: boundary === "concurrent" ? 3 : 1 }, (_, i) => {
      const child = Bun.spawn([process.execPath, import.meta.path, "--execute", "--worker", directory, "--boundary", boundary],
        { stdout: Bun.file(join(directory, `stdout-${i}.log`)), stderr: Bun.file(join(directory, `stderr-${i}.log`)), stdin: "ignore" });
      return { child, index: i, pid: child.pid };
    });
    const exits = await Promise.all(workers.map(async w => ({ pid: w.pid, index: w.index, exitCode: await w.child.exited, signal: w.child.signalCode })));
    await atomicJson(join(directory, "processes.json"), exits);
    const transport = forge(directory);
    let hiddenResult;
    if (boundary === "after-accepted") hiddenResult = await publishReview(request, { ...transport, list: async () => [] }, join(directory, "intent.json"));
    const first = await publishReview(request, transport, join(directory, "intent.json"));
    const second = await publishReview(request, transport, join(directory, "intent.json"));
    const remote = (await transport.list()).filter(v => String(v.body).includes(reviewOperationMarker(request)));
    const postFile = Bun.file(join(directory, "post-attempts.jsonl"));
    const posts = await postFile.exists() ? (await postFile.text()).trim().split("\n").length : 0;
    const expected = boundary === "after-claim" ? 0 : 1;
    const checks = { processes: exits.every(e => boundary === "concurrent" ? e.exitCode === 0 : e.signal === "SIGKILL"),
      noDuplicatePost: posts === expected, exactRemoteCount: remote.length === expected,
      reconciled: [first, second].every(v => v.state === (expected ? "verified" : "pending")),
      hiddenReceipt: boundary !== "after-accepted" || hiddenResult?.state === "pending" };
    const row = { boundary, exits, posts, checks, first, second, hiddenResult, remote, passed: Object.values(checks).every(Boolean) };
    results.push(row); await atomicJson(join(directory, "result.json"), row);
    console.log(JSON.stringify({ boundary, checks, passed: row.passed }));
  }
  await guard();
  const result = { results, passed: results.every(r => r.passed), finishedAt: new Date().toISOString() };
  await atomicJson(join(output, "result.json"), result);
  if (!result.passed) process.exitCode = 1;
}
