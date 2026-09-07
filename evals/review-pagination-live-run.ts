import { mkdir, cp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { command, digest } from "./github-live.ts";
import { atomicJson } from "./issue-receipt.ts";
if (process.env.CI || process.env.GITHUB_ACTIONS || !Bun.argv.includes("--execute"))
  throw Error("Real feedback fixture writes require explicit local --execute");
const arg = (name: string) => { const i = Bun.argv.indexOf(name); return i < 0 ? undefined : Bun.argv[i + 1]; };
if (!arg("--output") || !arg("--before-helper")) throw Error("Supply fresh --output and frozen --before-helper");
const output = resolve(arg("--output")!);
await mkdir(output);
const repository = "frostney/kgr-eval-20260906-native-stack", repositoryId = 1358673926, pr = 2;
const head = "a053acc9ffb0f2d7294e0f6e092121c4d4db08a8";
const operation = "kgr-review-pagination-20260906-v1";
const api = async (path: string, body?: unknown) => JSON.parse(await command([
  "gh", "api", path, ...(body ? ["--method", "POST", "--input", "-"] : []),
], undefined, body ? JSON.stringify(body) : undefined));
const list = async (path: string) => JSON.parse(await command(["gh", "api", path + "?per_page=100", "--paginate", "--slurp"])).flat();
const guard = async () => {
  const repo = await api(`repos/${repository}`), pull = await api(`repos/${repository}/pulls/${pr}`);
  const user = await api("user");
  if (repo.id !== repositoryId || !repo.private || repo.full_name !== repository ||
      pull.head.sha !== head || !pull.draft || pull.state !== "open" || pull.merged || user.login !== "frostney")
    throw Error("Unexpected fixture repository/head/account/state");
};
await guard();
const attribution = "\n\n> [!NOTE]\n> Created on behalf of @frostney using GPT-6 Astra.";
const body = (text: string, key: string) => `Synthetic evaluation fixture: ${text}${attribution}\n\n<!-- ${operation}:${key} -->`;
const summary = body("fixture review pending. This labelled incomplete review event tests whether an older successful check can incorrectly establish completion. It is not an actual provider rate-limit report or independent review.", "review");
const topBody = body("Pagination must retain this second top-level feedback item and the existing finding. The code's atomic-batch defect remains intentionally present.", "comment");
const inline = [
  { path: "src/batch.mjs", line: 8, side: "RIGHT", body: body("This write happens before every operation in the batch has been validated. A later invalid operation leaves earlier writes applied. The negative fixture intentionally retains this flaw.", "inline-batch") },
  { path: "tests/batch.test.mjs", line: 7, side: "RIGHT", body: body("The invalid batches here begin with an invalid operation. Include a valid write followed by an invalid operation to expose partial mutation. This is labelled test feedback, not a request to rewrite the frozen fixture.", "inline-test") },
];
const replyBody = body("Synthetic reply for nested-comment pagination. The reported defect is still present; this acknowledgement does not claim a fix or resolve the thread.", "reply");
const beforeHelper = resolve(arg("--before-helper")!);
const currentHelper = join(output, "snapshot/address-feedback/scripts/review_wait.py");
await mkdir(join(output, "snapshot/address-feedback/scripts"), { recursive: true });
for (const file of ["review_wait.py", "review_observation.py", "review_mutations.py"])
  await cp(join("address-feedback/scripts", file), join(output, "snapshot/address-feedback/scripts", file));
await cp("delivery-wait/scripts", join(output, "snapshot/delivery-wait/scripts"), { recursive: true });
const policyPath = join(output, "fixture-policy.json");
await atomicJson(policyPath, { automations: [{ id: "synthetic-review", actors: ["frostney"],
  check_contexts: ["project-gate"], check_app_slugs: ["github-actions"], terminal_check_conclusions: ["success"],
  terminal_review_states: ["COMMENTED"], nonterminal_review_markers: ["fixture review pending"] }] });
await atomicJson(join(output, "plan.json"), { repository, repositoryId, pr, head, operation,
  beforeHelper, beforeHash: digest(await Bun.file(beforeHelper).text()), currentHelper,
  helperHashes: Object.fromEntries(await Promise.all(["review_wait.py", "review_observation.py", "review_mutations.py"].map(async file =>
    [file, digest(await Bun.file(join(output, "snapshot/address-feedback/scripts", file)).text())]))),
  topBody, summary, inline, replyBody, policyPath, createdAt: new Date().toISOString(),
  policyMeaning: "Synthetic caller-owned policy to test ordering only; no repository policy changes or real provider completion claims." });
await atomicJson(join(output, "before-feedback.json"), {
  comments: await list(`repos/${repository}/issues/${pr}/comments`),
  reviews: await list(`repos/${repository}/pulls/${pr}/reviews`),
  inline: await list(`repos/${repository}/pulls/${pr}/comments`),
});
const reconcile = async (path: string, key: string, payload: any) => {
  const matches = (await list(path)).filter((x: any) => String(x.body).includes(`<!-- ${operation}:${key} -->`));
  if (matches.length > 1) throw Error(`Duplicate ${key} operation`);
  let receipt = matches[0];
  if (!receipt) {
    await guard();
    receipt = await api(path, payload);
    await atomicJson(join(output, `${key}-response.json`), receipt);
  }
  if (receipt.body !== payload.body || receipt.user.login !== "frostney") throw Error(`Unexpected ${key} body/author`);
  await atomicJson(join(output, `${key}-receipt.json`), receipt);
  return receipt;
};
const comment = await reconcile(`repos/${repository}/issues/${pr}/comments`, "comment", { body: topBody });
const submitted = await reconcile(`repos/${repository}/pulls/${pr}/reviews`, "review", { body: summary, event: "COMMENT", commit_id: head, comments: inline });
const reviewReceipt = await api(`repos/${repository}/pulls/${pr}/reviews/${submitted.id}`);
if (reviewReceipt.commit_id !== head || reviewReceipt.state !== "COMMENTED" || reviewReceipt.body !== summary)
  throw Error("Unexpected bound review receipt");
const threadComments = await list(`repos/${repository}/pulls/${pr}/comments`);
const origins = inline.map((finding: any) => {
  const matches = threadComments.filter((x: any) => x.pull_request_review_id === submitted.id && x.path === finding.path && x.body === finding.body);
  if (matches.length !== 1 || matches[0].commit_id !== head || matches[0].line !== finding.line)
    throw Error("Missing or mismatched inline finding receipt");
  return matches[0];
});
const priorReplies = threadComments.filter((x: any) => String(x.body).includes(`<!-- ${operation}:reply -->`));
if (priorReplies.length > 1) throw Error("Duplicate nested reply operation");
let reply = priorReplies[0];
if (!reply) {
  await guard();
  reply = await api(`repos/${repository}/pulls/${pr}/comments/${origins[0].id}/replies`, { body: replyBody });
}
if (reply.body !== replyBody || reply.in_reply_to_id !== origins[0].id || reply.user.login !== "frostney")
  throw Error("Mismatched nested reply receipt");
await atomicJson(join(output, "verified-feedback.json"), { comment, review: reviewReceipt, origins, reply });
const replyReview = await api(`repos/${repository}/pulls/${pr}/reviews/${reply.pull_request_review_id}`);
await atomicJson(join(output, "reply-review.json"), replyReview);
const observe = async (label: string, helper: string, pageSize?: number) => {
  const value = JSON.parse(await command(["python3", helper, "inspect", "--repo", repository, "--pr", String(pr),
    "--head", head, "--policy", policyPath, "--json", ...(pageSize ? ["--page-size", String(pageSize)] : [])]));
  await atomicJson(join(output, `${label}.json`), value);
  return value;
};
const old = await observe("old-helper", beforeHelper);
const large = await observe("new-page-100", currentHelper, 100);
const small = await observe("new-page-1", currentHelper, 1);
await guard();
const capturedIds = new Set(small.observation.findingSurfaces.map((s: any) => s.id));
const checks = {
  oldStaleCompletion: old.observation.automations[0].terminal === true,
  newPending: large.observation.automations[0].terminal === false && small.state === "waiting",
  pageEquivalence: JSON.stringify(large.observation) === JSON.stringify(small.observation),
  actualPagination: small.metrics.apiRequests > large.metrics.apiRequests && small.metrics.apiRequests >= 12,
  findingBodies: capturedIds.has(comment.node_id) && capturedIds.has(submitted.node_id) &&
    origins.every((o: any) => small.observation.threads.some((t: any) => t.comments.some((c: any) => c.nodeId === o.node_id && c.body === o.body))),
  nestedReply: small.observation.threads.some((t: any) => t.comments.some((c: any) => c.nodeId === reply.node_id && c.body === replyBody && c.reply)),
};
await atomicJson(join(output, "result.json"), { checks, passed: Object.values(checks).every(Boolean), repository, pr, head,
  artifacts: [comment, submitted, ...origins, reply, replyReview].map((x: any) => ({ id: x.id, nodeId: x.node_id, url: x.html_url })),
  apiRequests: { page100: large.metrics.apiRequests, page1: small.metrics.apiRequests }, verifiedAt: new Date().toISOString() });
console.log(JSON.stringify(checks));
if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
