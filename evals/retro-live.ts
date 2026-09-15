import { join } from "node:path";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { command, digest, liveCase, type LiveConfig } from "./github-live.ts";
import { issueLiveTools, githubIssueForge, type IssueLiveConfig } from "./issue-live.ts";
import { atomicJson, readCheckpoint, matchesIssue } from "./issue-receipt.ts";
import { loadSkills, formatSkillCatalog } from "./skill-loader.ts";
import { preflight, runLocal, parseModel } from "./local-runtime.ts";
import { completedReview } from "./review-receipt.ts";
import { readLiveReviewEvidence } from "./live-review-evidence.ts";
import type { RunLedger } from "./types.ts";

export interface RetroLiveConfig {
  issueConfig: string;
  issue: IssueLiveConfig;
  delivery: LiveConfig;
}
export const retroOutcome = z.object({
  status: z.enum(["delivered", "blocked"]),
  issueUrl: z.string().url().nullable(),
  prUrl: z.string().url().nullable(),
  head: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  reason: z.string().min(1),
}).strict();
// Native CLI transport uses the same minimal JSON-schema subset as issueOutcome.
// Validate URLs, hashes and semantic status separately after the response arrives.
export const retroOutcomeSchema = {
  type: "object", additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["delivered", "blocked"] },
    issueUrl: { type: ["string", "null"] }, prUrl: { type: ["string", "null"] },
    head: { type: ["string", "null"] }, reason: { type: "string" },
  },
  required: ["status", "issueUrl", "prUrl", "head", "reason"],
};
export const retroCorrection = "Preserve every supplied string exactly, including leading/trailing whitespace, empty strings, embedded newlines and Unicode, then append one newline. Preserve the existing non-string rejection. Only app.mjs may change; tests, CI and repository infrastructure are fixed. Remove the trimming at the existing output expression; no redesign.";
export function implementationReport(result: any) {
  return {
    output: result.output, error: result.error, model: result.model,
    responseModels: result.responseModels, version: result.version,
    loadedSkills: result.ledger?.loadedSkills ?? [],
  };
}
export function deliveryChecks(c: LiveConfig, result: any, state: any, observed: any) {
  const published = state.events?.findLast((e: any) => e.action === "draftPublished");
  const ready = state.events?.findLast((e: any) => e.action === "ready");
  const review = completedReview(state, observed.revision);
  const gate = observed.checkRuns.filter((r: any) => r.name === "project-gate" && r.head_sha === observed.pr.head?.sha);
  return {
    workerCompleted: Boolean(result && !result.error && result.exitCode === 0),
    workerModel: result?.model === c.model && (c.model.startsWith("codex:") ||
      (result.responseModels?.length > 0 && result.responseModels.every((m: string) => m === parseModel(c.model).model))),
    implementationLoaded: result?.ledger?.loadedSkills.includes("implement") === true,
    publicationLoaded: result?.ledger?.loadedSkills.includes("create-pr") === true,
    reproduced: state.checks?.some((g: any) => !g.passed) === true,
    currentGate: state.checks?.some((g: any) => g.passed && g.revision === observed.revision) === true,
    currentReview: Boolean(review && published?.reviewAttempt === review.attempt && published.revision === observed.revision),
    boundedChange: observed.status === "" && isDeepStrictEqual(observed.files, ["app.mjs"]),
    currentHead: state.head === observed.head && state.head !== c.base && observed.pr.head?.sha === state.head && observed.pr.head?.ref === c.branch,
    linkedIssue: typeof c.issueUrl === "string" && observed.pr.body?.includes(`Closes ${c.issueUrl}`) === true,
    waitExecuted: state.events?.some((e: any) => e.action === "ciObserved" && e.code === 0 && e.observed?.state === "satisfied" && e.observed?.identity?.head === state.head) === true,
    exactHeadCi: gate.length === 1 && gate[0].status === "completed" && gate[0].conclusion === "success",
    draftBeforeReady: Boolean(published && ready && state.events.indexOf(published) < state.events.indexOf(ready) && ready.head === state.head),
    remoteReady: observed.pr.draft === false && observed.pr.state === "open" && !observed.pr.merged_at,
  };
}
export async function observeRetroDelivery(c: LiveConfig) {
  const read = async (path: string) => JSON.parse(await command(["gh", "api", `repos/${c.repository}${path}`]));
  const identity = await read("");
  if (identity.id !== c.repositoryId || identity.full_name !== c.repository || !identity.private) throw new Error("Delivery repository identity changed");
  const resultFile = join(c.evidence, "implementation-result.json");
  const stateFile = join(c.evidence, "state.json");
  if (!(await Bun.file(resultFile).exists()) || !(await Bun.file(stateFile).exists()))
    return { delivered: false, prUrl: null, head: null, reason: "No terminal implementation and publication state" };
  const result = await Bun.file(resultFile).json(), state = await Bun.file(stateFile).json();
  if (!state.pr) return { delivered: false, prUrl: null, head: null, reason: "Implementation has no published PR", report: implementationReport(result) };
  const pr = await read(`/pulls/${state.pr}`);
  const pages = JSON.parse(await command(["gh", "api", "--paginate", "--slurp", `repos/${c.repository}/commits/${pr.head.sha}/check-runs?per_page=100`]));
  const git = (...args: string[]) => command(["git", ...args], c.directory);
  const head = await git("rev-parse", "HEAD");
  // command trims text, so retain exact application bytes through Bun instead.
  const revision = digest(await Bun.file(join(c.directory, "app.mjs")).text());
  const observed = { pr, checkRuns: pages.flatMap((p: any) => p.check_runs), head, revision,
    status: await git("status", "--porcelain"), files: (await git("diff", "--name-only", c.base)).split("\n").filter(Boolean) };
  const checks = deliveryChecks(c, result, state, observed);
  const review = completedReview(state, revision);
  const reviewEvidence = review ? await readLiveReviewEvidence(c, state, review) : null;
  const evidence = { delivered: Boolean(reviewEvidence) && Object.values(checks).every(Boolean), checks, reviewEvidence, issueUrl: c.issueUrl, prUrl: pr.html_url, head, revision, checkUrls: observed.checkRuns.filter((r: any) => r.name === "project-gate").map((r: any) => r.html_url) };
  await atomicJson(join(c.evidence, "delivery-observed.json"), { observedAt: new Date().toISOString(), evidence, observed });
  return evidence;
}
export async function retroLiveTools(configPath: string, ledger: RunLedger, lifecycle: AbortSignal) {
  const c: RetroLiveConfig = await Bun.file(configPath).json();
  const tools = await issueLiveTools(c.issueConfig, "parent", ledger, lifecycle);
  tools.inspectRetro = {
    description: "Read the exact already-selected retrospective action and its normal delivery contract. No new interview or decision is pending.",
    inputSchema: z.object({}),
    execute: async () => {
      ledger.inspections.push("confirmed-retro-action");
      return {
        selected: true, grillingCompleted: true, action: retroCorrection,
        boundary: "Only this selected immediate action remains in the retrospective. The previous summary and selection are settled; continue until delivered or genuinely blocked. No documentation edit, other ticket or audit is selected.",
        issue: "No prior issue has this trial's unique operation marker. Delegate create-issue automatic using delegateIssue, then independently reconcileIssue. This test explicitly authorizes posting with observed worker attribution.",
        implementation: "After verifying the visibility issue, delegateImplementation through normal /implement. Include the verified issue URL and complete selected scope. The worker reads actual repository instructions and issue, reproduces, fixes, checks, obtains native independent review, publishes a draft with /create-pr, waits for exact-head CI through delivery-wait, and marks ready. This test authorizes those commits/pushes/PR operations only in the disposable repository. No merge.",
        completion: "A worker summary alone is insufficient. Call inspectDelivery after the worker returns and use its independently verified status. Do not claim delivery unless delivered=true. Final JSON status delivered or blocked, issueUrl, prUrl, head and reason.",
      };
    },
  };
  const requireRetro = () => {
    if (!ledger.loadedSkills.includes("run-retro") || !ledger.inspections.includes("confirmed-retro-action"))
      throw new Error("Load run-retro and inspect the selected action in this coordinator first");
  };
  tools.delegateImplementation = {
    description: "Run one actual native implementation worker after a verified visibility issue. Pass its exact issue URL and complete selected task; return its terminal report, then independently inspectDelivery. No parent history is inherited.",
    inputSchema: z.object({ context: z.string().min(40).max(18000) }),
    execute: async ({ context }: { context: string }) => {
      requireRetro(); lifecycle.throwIfAborted();
      const checkpoint = await readCheckpoint(join(c.issue.evidence, "issue-checkpoint.json"));
      const receiptFile = join(c.issue.evidence, "parent-receipt.json");
      const receipt = (await Bun.file(receiptFile).exists()) ? await Bun.file(receiptFile).json() : null;
      if (!checkpoint?.issue || !receipt?.issueUrl || receipt.issueUrl !== checkpoint.issue.html_url)
        throw new Error("Independently reconcile the visibility issue before implementation");
      const remote = await githubIssueForge(c.issue.target).get(checkpoint.issue.number);
      if (!matchesIssue(c.issue.target, remote, checkpoint) || !context.includes(remote.html_url))
        throw new Error("Worker packet requires the verified visibility issue URL");
      const delivery: LiveConfig = { ...c.delivery, issueUrl: remote.html_url };
      const resultPath = join(delivery.evidence, "implementation-result.json");
      if (await Bun.file(resultPath).exists()) return implementationReport(await Bun.file(resultPath).json());
      const startPath = join(delivery.evidence, "implementation-started.json");
      if (await Bun.file(startPath).exists()) throw new Error("Implementation already dispatched; inspect durable state instead of restarting");
      const version = await preflight(delivery.model);
      const instructions = formatSkillCatalog(await loadSkills(delivery.skillsRoot)) + "\nUse only supplied tools on the actual disposable repository. Follow normal implement and publication gates. The coordinator's selected action authorizes this bounded implementation and test PR delivery. Read the actual issue and repository contract with inspectLiveRepo. Keep findings, checks and publication claims tied to returned evidence. Do not merge.";
      await atomicJson(startPath, { context, instructions, model: delivery.model, version });
      const deliveryConfig = join(delivery.evidence, "delivery-config.json");
      await atomicJson(deliveryConfig, delivery);
      const result = await runLocal({
        target: delivery.model, effort: "medium", skillsRoot: delivery.skillsRoot,
        evalCase: { ...liveCase, prompt: context }, instructions, signal: lifecycle,
        transcript: join(delivery.evidence, "implementation.jsonl"),
        server: { path: join(delivery.skillsRoot, "evals/github-live-server.ts"), args: [deliveryConfig, "implementation"],
          approvedTools: ["loadSkill", "readSkillReference", "inspectLiveRepo", "runProjectGate", "editApplication", "reviewChange", "publishDraft", "waitCi", "markReady", "researchContract", "syncRemoteDefault"] },
      });
      const retained = { ...result, model: delivery.model, context, instructions, version };
      await atomicJson(resultPath, retained);
      return implementationReport(retained);
    },
  };
  tools.inspectDelivery = {
    description: "Independently inspect actual GitHub PR/checks and local content/review/worker records. Only delivered=true proves the selected action's normal delivery gates passed. Does not dispatch or retry a worker.",
    inputSchema: z.object({}),
    execute: async () => {
      requireRetro(); ledger.inspections.push("delivery-result");
      const path = join(c.delivery.evidence, "delivery-config.json");
      return (await Bun.file(path).exists()) ? observeRetroDelivery(await Bun.file(path).json()) : { delivered: false, reason: "No implementation dispatched" };
    },
  };
  return tools;
}
