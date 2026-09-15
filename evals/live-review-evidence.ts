import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { parseEvents, parseModel } from "./local-runtime.ts";
import { loadSkills, formatSkillCatalog } from "./skill-loader.ts";
import { verifyToolReceiptTranscript } from "./tool-receipts.ts";
import type { LiveConfig } from "./github-live.ts";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export function liveReviewTask(c: Pick<LiveConfig, "model" | "repository">, attempt: string, revision: string, catalog: string) {
  return {
    version: 1, model: c.model, repository: c.repository, attempt, revision, effort: "medium" as const,
    prompt: "Use code-review to inspect the actual change against the repository contract. Read actual diff and tests. Reuse matching observed gate or run it if needed. Submit a review with concrete findings and verdict. Read-only; no publication or edits.",
    instructions: catalog + "\nUse only provided MCP tools. They read the real disposable repository; submitReview records your terminal result. Do not claim evidence you did not inspect.",
  };
}
export function verifyLiveReviewEvidence(options: {
  model: string; revision: string; attempt: string; review: any; process: any;
  result: any; transcript: string; task: unknown; expectedTask: ReturnType<typeof liveReviewTask>;
}) {
  const { model, revision, attempt, review, result, transcript, task, expectedTask } = options;
  const process = options.process;
  if (!isDeepStrictEqual(task, expectedTask) || expectedTask.attempt !== attempt || expectedTask.revision !== revision || expectedTask.model !== model)
    throw new Error("Native review task packet is missing or does not match the dispatched task");
  if (!review || review.attempt !== attempt || review.revision !== revision || review.model !== model ||
    !process || process.attempt !== attempt || process.revision !== revision || process.model !== model ||
    process.completed !== true || process.exitCode !== 0 || process.error || process.cancellationRequested ||
    result?.error || result?.exitCode !== 0 || result?.cancellationRequested || result?.ledger?.workers?.length)
    throw new Error("Native review lacks matching successful terminal evidence");
  const cli = parseModel(model).cli, parsed = parseEvents(cli, transcript);
  if (parsed.error || parsed.output !== result.output ||
    !isDeepStrictEqual(parsed.responseModels, result.responseModels) ||
    !isDeepStrictEqual(parsed.responseModels, process.responseModels))
    throw new Error("Native review output or response metadata does not match the transcript");
  if (cli === "claude" && (!parsed.responseModels.length || parsed.responseModels.some(m => m !== parseModel(model).model)))
    throw new Error("Actual review response model is missing or mismatched");
  const pairs = verifyToolReceiptTranscript(result.ledger, cli, transcript);
  const receipts = result.ledger.toolReceipts!;
  const allowed = new Set(["loadSkill", "readSkillReference", "inspectLiveRepo", "runProjectGate", "submitReview", "researchContract"]);
  if (receipts.some((r: any) => !allowed.has(r.request.params?.name)))
    throw new Error("Review attempted a tool outside its read-only contract");
  const submissions = receipts.filter((r: any) => r.request.params?.name === "submitReview");
  const submitted = submissions[0];
  if (submissions.length !== 1 || submitted.state !== "completed" || submitted.response.isError ||
    !isDeepStrictEqual(submitted.request.params.arguments, { verdict: review.verdict, findings: review.findings, reason: review.reason }))
    throw new Error("Retained review does not match its unique captured submission");
  const before = receipts.slice(0, receipts.indexOf(submitted));
  const payload = (r: any) => r.state === "completed" && !r.response.isError && r.response.content.length === 1 ? JSON.parse(r.response.content[0].text) : null;
  if (!result.ledger.loadedSkills.includes("code-review") || !process.loadedSkills?.includes("code-review") ||
    !before.some((r: any) => r.request.params?.name === "loadSkill" && r.request.params.arguments?.name === "code-review" && payload(r)?.ok === true))
    throw new Error("Review procedure was not loaded before submission");
  if (!before.some((r: any) => r.request.params?.name === "inspectLiveRepo" && typeof payload(r)?.content === "string" && sha(payload(r).content) === revision))
    throw new Error("Review did not inspect the matching application content before submission");
  return { attempt, revision, model, responseModels: parsed.responseModels,
    modelIdentity: cli === "claude" ? "actual-response" : "configured-only",
    pairs, transcriptSha256: sha(transcript), resultSha256: sha(JSON.stringify(result)), taskSha256: sha(JSON.stringify(task)) };
}
export async function readLiveReviewEvidence(c: LiveConfig, state: any, review: any) {
  const attempt = review?.attempt;
  if (typeof attempt !== "string" || !/^[a-f0-9-]{36}$/.test(attempt)) throw new Error("Invalid native review attempt identity");
  const prefix = join(c.evidence, `review-${attempt}`);
  const processes = state.events.filter((e: any) => e.action === "reviewProcess" && e.attempt === attempt);
  if (processes.length !== 1 || processes[0].transcript !== prefix + ".jsonl") throw new Error("No unique native reviewer process for the recorded attempt");
  const [config, task, result, transcript, skills] = await Promise.all([
    Bun.file(prefix + "-config.json").json(), Bun.file(prefix + "-task.json").json(),
    Bun.file(prefix + "-result.json").json(), Bun.file(prefix + ".jsonl").text(), loadSkills(c.skillsRoot),
  ]);
  if (!isDeepStrictEqual(config, { ...c, reviewAttempt: { id: attempt, revision: review.revision } })) throw new Error("Native review configuration changed");
  return verifyLiveReviewEvidence({ model: c.model, revision: review.revision, attempt, review, process: processes[0], result, transcript, task,
    expectedTask: liveReviewTask(c, attempt, review.revision, formatSkillCatalog(skills)) });
}
