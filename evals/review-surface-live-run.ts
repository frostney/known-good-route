import { mkdir, cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { command, digest } from "./github-live.ts";
import { atomicJson } from "./issue-receipt.ts";

// A real GitHub regression fixture. The only writes are two labelled feedback
// artifacts in the explicitly authorized disposable repository; no PR/head edits.
if (process.env.CI || process.env.GITHUB_ACTIONS || !Bun.argv.includes("--execute"))
  throw Error("Live feedback fixtures require explicit local --execute");
const arg = (name: string) => {
  const i = Bun.argv.indexOf(name);
  return i < 0 ? undefined : Bun.argv[i + 1];
};
if (!arg("--output") || !arg("--before-helper"))
  throw Error("Supply a fresh --output and preserved --before-helper");
const output = resolve(arg("--output")!);
await mkdir(output);
const repository = "frostney/kgr-eval-20260906-native-stack";
const repositoryId = 1358673926;
const pr = 2;
const head = "a053acc9ffb0f2d7294e0f6e092121c4d4db08a8";
const operation = "kgr-review-surface-regression-20260906-v1";
const api = async (path: string, body?: unknown) => JSON.parse(await command(
  ["gh", "api", path, ...(body ? ["--method", "POST", "--input", "-"] : [])],
  undefined, body ? JSON.stringify(body) : undefined,
));
const guard = async () => {
  const repo = await api(`repos/${repository}`);
  const pull = await api(`repos/${repository}/pulls/${pr}`);
  if (repo.id !== repositoryId || !repo.private || repo.full_name !== repository ||
      pull.head.sha !== head || pull.state !== "open" || !pull.draft || pull.merged)
    throw Error("Disposable repository/PR identity or state changed");
  return pull;
};
await guard();
const user = await api("user");
if (user.login !== "frostney") throw Error("Unexpected authenticated GitHub account");
const attribution = `\n\n> [!NOTE]\n> Created on behalf of @${user.login} using GPT-6 Astra.`;
const commentBody = `Synthetic evaluation finding: executeBatch applies earlier writes before validating a later operation. An invalid batch must leave the store unchanged. This is labelled fixture feedback for the authorized hardening tests.${attribution}\n\n<!-- ${operation}:comment -->`;
const reviewBody = `Synthetic evaluation finding: Store.get treats null, false, zero and empty strings as absent. These are valid stored JSON values under the fixture contract. This COMMENT review is test data, not an independent review completion.${attribution}\n\n<!-- ${operation}:review -->`;
const beforeHelper = resolve(arg("--before-helper")!);
const currentHelper = join(output, "snapshot/address-feedback/scripts/review_wait.py");
await mkdir(join(output, "snapshot/address-feedback/scripts"), { recursive: true });
await cp("address-feedback/scripts/review_wait.py", currentHelper);
await cp("address-feedback/scripts/review_observation.py", join(output, "snapshot/address-feedback/scripts/review_observation.py"));
await cp("address-feedback/scripts/review_mutations.py", join(output, "snapshot/address-feedback/scripts/review_mutations.py"));
await cp("delivery-wait/scripts", join(output, "snapshot/delivery-wait/scripts"), { recursive: true });
const policyPath = join(output, "explicit-empty-policy.json");
await atomicJson(policyPath, { automations: [] });
await atomicJson(join(output, "plan.json"), {
  repository, repositoryId, pr, head, operation, commentBody, reviewBody,
  beforeHelper, beforeHash: digest(await Bun.file(beforeHelper).text()),
  currentHelper, currentHash: digest(await Bun.file(currentHelper).text()),
  policyMeaning: "Caller-owned empty policy for the comparison only; does not assert repository requirements or change repository policy.",
  createdAt: new Date().toISOString(),
});
const list = async (path: string) => JSON.parse(await command([
  "gh", "api", path + "?per_page=100", "--paginate", "--slurp",
])).flat();
const reconcile = async (kind: "comment" | "review") => {
  const path = kind === "comment" ? `repos/${repository}/issues/${pr}/comments` : `repos/${repository}/pulls/${pr}/reviews`;
  const body = kind === "comment" ? commentBody : reviewBody;
  const matches = (await list(path)).filter((item: any) => String(item.body).includes(`<!-- ${operation}:${kind} -->`));
  if (matches.length > 1) throw Error(`Duplicate ${kind} operation`);
  let receipt = matches[0];
  if (!receipt) {
    await guard();
    receipt = await api(path, kind === "comment" ? { body } : { body, event: "COMMENT", commit_id: head });
    await atomicJson(join(output, `${kind}-response.json`), receipt);
  }
  const verified = await api(kind === "comment" ? `repos/${repository}/issues/comments/${receipt.id}` : `${path}/${receipt.id}`);
  if (verified.body !== body || verified.user.login !== user.login ||
      (kind === "review" && (verified.commit_id !== head || verified.state !== "COMMENTED")))
    throw Error(`Unexpected ${kind} receipt`);
  await atomicJson(join(output, `${kind}-verified.json`), verified);
  return verified;
};
const comment = await reconcile("comment");
const review = await reconcile("review");
const observe = async (label: string, helper: string, policy: string) => {
  const process = Bun.spawn(["python3", helper, "inspect", "--repo", repository,
    "--pr", String(pr), "--head", head, "--policy", policy, "--json"],
    { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
  ]);
  await Bun.write(join(output, `${label}.stdout`), stdout);
  await Bun.write(join(output, `${label}.stderr`), stderr);
  const value = JSON.parse(stdout);
  await atomicJson(join(output, `${label}.json`), { exitCode, value });
  return { exitCode, value };
};
const before = await observe("before-explicit-policy", beforeHelper, policyPath);
const after = await observe("after-explicit-policy", currentHelper, policyPath);
const unknown = await observe("after-missing-policy", currentHelper, join(output, "absent-policy.json"));
await guard();
const containsBoth = (result: any) => {
  const surfaces = result.value.observation.findingSurfaces;
  return surfaces.some((s: any) => s.kind === "review" && s.id === review.node_id && s.review.body === reviewBody) &&
    surfaces.some((s: any) => s.kind === "top-level-comment" && s.id === comment.node_id && s.comment.body === commentBody);
};
const checks = {
  reproducedOmission: before.exitCode === 0 && before.value.state === "satisfied" && before.value.observation.findingSurfaceCount === 0,
  repairedDiscovery: after.exitCode === 0 && after.value.state === "judgment-required" && containsBoth(after),
  unknownPolicy: unknown.exitCode === 0 && unknown.value.state === "waiting" &&
    unknown.value.observation.policyAvailable === false && unknown.value.observation.unansweredAutomationThreads === null && containsBoth(unknown),
};
await atomicJson(join(output, "result.json"), { checks, passed: Object.values(checks).every(Boolean), repository, pr, head,
  comment: comment.html_url, review: review.html_url, verifiedAt: new Date().toISOString() });
console.log(JSON.stringify(checks));
if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
