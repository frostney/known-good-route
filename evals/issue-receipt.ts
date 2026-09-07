import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";

export const issueOutcome = z
  .object({
    status: z.enum(["created", "existing", "recovered", "blocked", "unknown"]),
    issueUrl: z.string().url().nullable(),
    reason: z.string().min(1),
  })
  .strict()
  .refine(
    (value) =>
      ["created", "existing", "recovered"].includes(value.status)
        ? value.issueUrl !== null
        : value.issueUrl === null,
    "Completion requires a URL; blocked/unknown outcomes must not assert one",
  );
export type IssueOutcome = z.infer<typeof issueOutcome>;
export const issueOutcomeSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: {
      type: "string",
      enum: ["created", "existing", "recovered", "blocked", "unknown"],
    },
    issueUrl: { type: ["string", "null"] },
    reason: { type: "string" },
  },
  required: ["status", "issueUrl", "reason"],
};
export interface RemoteIssue {
  number: number;
  html_url: string;
  title: string;
  body: string;
  user: { login: string };
  pull_request?: unknown;
}
export interface IssueTarget {
  repository: string;
  repositoryId: number;
  key: string;
  actor: string | null;
  model: string | null;
  subject?: string;
}
export interface IssueForge {
  identity(): Promise<{ id: number; full_name: string; private: boolean }>;
  actor(): Promise<string | null>;
  list(): Promise<RemoteIssue[]>;
  get(number: number): Promise<RemoteIssue>;
  create(title: string, body: string): Promise<RemoteIssue>;
}
export interface IssueCheckpoint {
  phase: "prepared" | "in-flight" | "verified";
  repository: string;
  repositoryId: number;
  key: string;
  title: string;
  body: string;
  issue?: RemoteIssue;
}
export function validateIssueTarget(t: IssueTarget) {
  if (
    !/^frostney\/kgr-eval-\d{8}-[a-z0-9-]+$/.test(t.repository) ||
    !Number.isSafeInteger(t.repositoryId) ||
    t.repositoryId <= 0 ||
    !/^[a-z0-9][a-z0-9-]{7,95}$/.test(t.key) ||
    (t.subject !== undefined && (typeof t.subject !== "string" ||
      t.subject.trim().length < 1 || t.subject.length > 100 || /[\r\n]/.test(t.subject)))
  )
    throw new Error("Invalid disposable issue target");
}
export const markerFor = (t: IssueTarget) => `<!-- kgr-eval:${t.key} -->`;
export const titleFor = (t: IssueTarget) =>
  `[KGR eval ${t.key}] ${t.subject ?? "Verify delegated issue completion"}`;
export async function atomicJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const f = await open(temporary, "wx", 0o600);
  try {
    await f.writeFile(JSON.stringify(value, null, 2) + "\n");
    await f.sync();
  } finally {
    await f.close();
  }
  await rename(temporary, path);
}
export async function readCheckpoint(
  path: string,
): Promise<IssueCheckpoint | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e: any) {
    if (e.code === "ENOENT") return undefined;
    throw e;
  }
}
// A short transaction lock, independent of native-agent process lifetime.
export async function withIssueLock<T>(
  path: string,
  work: () => Promise<T>,
): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  let handle;
  try {
    handle = await open(lock, "wx", 0o600);
  } catch (e: any) {
    if (e.code !== "EEXIST") throw e;
    const pid = Number(await readFile(lock, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error("Unverifiable issue lock; preserve it");
    try {
      process.kill(pid, 0);
      throw new Error("Issue operation is still live; reconcile later");
    } catch (probe: any) {
      if (probe.code !== "ESRCH") throw probe;
    }
    // Do not break locks automatically: two rescuers could both unlink a new lock.
    throw new Error(
      "Dead issue lock requires explicit recovery after verifying the owner",
    );
  }
  try {
    await handle.writeFile(String(process.pid));
    return await work();
  } finally {
    await handle.close();
    await unlink(lock);
  }
}
export function matchesIssue(
  t: IssueTarget,
  issue: RemoteIssue,
  checkpoint?: IssueCheckpoint,
) {
  return (
    Number.isSafeInteger(issue.number) &&
    issue.number > 0 &&
    !issue.pull_request &&
    issue.html_url ===
      `https://github.com/${t.repository}/issues/${issue.number}` &&
    issue.title === titleFor(t) &&
    issue.body.includes(markerFor(t)) &&
    Boolean(t.actor && t.model) &&
    issue.user.login === t.actor &&
    issue.body.endsWith(
      `> [!NOTE]\n> Created on behalf of @${t.actor} using ${t.model}.`,
    ) &&
    (!checkpoint ||
      (issue.title === checkpoint.title &&
        issue.body === checkpoint.body &&
        (!checkpoint.issue || issue.number === checkpoint.issue.number)))
  );
}
export async function verifyTarget(t: IssueTarget, forge: IssueForge) {
  validateIssueTarget(t);
  const id = await forge.identity();
  if (id.id !== t.repositoryId || id.full_name !== t.repository || !id.private)
    throw new Error("Disposable repository identity changed");
}
export async function reconcileIssue(
  t: IssueTarget,
  forge: IssueForge,
  path: string,
): Promise<IssueOutcome> {
  await verifyTarget(t, forge);
  const checkpoint = await readCheckpoint(path);
  if (
    checkpoint &&
    (checkpoint.repository !== t.repository ||
      checkpoint.repositoryId !== t.repositoryId ||
      checkpoint.key !== t.key)
  )
    throw new Error("Checkpoint belongs to another operation");
  const candidates = (await forge.list()).filter(
    (i) => !i.pull_request && (i.body ?? "").includes(markerFor(t)),
  );
  if (candidates.length > 1)
    return {
      status: "blocked",
      issueUrl: null,
      reason: "Multiple operation markers; do not post or choose arbitrarily",
    };
  if (candidates.length === 1 || checkpoint?.issue) {
    const issue = await forge.get(
      candidates[0]?.number ?? checkpoint!.issue!.number,
    );
    if (!matchesIssue(t, issue, checkpoint))
      return {
        status: "blocked",
        issueUrl: null,
        reason: "Issue identity, attribution or content mismatch",
      };
    return {
      status: checkpoint?.phase === "in-flight" ? "recovered" : "existing",
      issueUrl: issue.html_url,
      reason:
        "Fresh GitHub read verified repository, content, operation marker and attribution",
    };
  }
  if (checkpoint?.phase === "in-flight" || checkpoint?.phase === "verified")
    return {
      status: "unknown",
      issueUrl: null,
      reason:
        "A write may have been accepted; absence from this read does not authorize another POST",
    };
  return {
    status: "blocked",
    issueUrl: null,
    reason:
      t.actor && t.model
        ? "No issue exists for this operation"
        : "Observed actor or model identity is unavailable",
  };
}
export async function createVerifiedIssue(
  t: IssueTarget,
  forge: IssueForge,
  path: string,
  content: string,
  afterAccepted?: () => Promise<void>,
): Promise<IssueOutcome> {
  return withIssueLock(path, async () => {
    await verifyTarget(t, forge);
    const prior = await reconcileIssue(t, forge, path);
    if (
      prior.status !== "blocked" ||
      prior.reason !== "No issue exists for this operation"
    )
      return prior;
    if (!t.actor || !t.model)
      return {
        status: "blocked",
        issueUrl: null,
        reason: "Observed actor and model required",
      };
    if ((await forge.actor()) !== t.actor)
      return {
        status: "blocked",
        issueUrl: null,
        reason: "Authenticated actor changed before posting",
      };
    const checkpoint: IssueCheckpoint = {
      phase: "prepared",
      repository: t.repository,
      repositoryId: t.repositoryId,
      key: t.key,
      title: titleFor(t),
      body: `${content.trim()}\n\n${markerFor(t)}\n\n> [!NOTE]\n> Created on behalf of @${t.actor} using ${t.model}.`,
    };
    await atomicJson(path, checkpoint);
    checkpoint.phase = "in-flight";
    await atomicJson(path, checkpoint);
    // Never automatically retry the POST: GitHub issue creation has no operation-key transaction here.
    try {
      const created = await forge.create(checkpoint.title, checkpoint.body);
      await afterAccepted?.();
      const observed = await forge.get(created.number);
      if (!matchesIssue(t, observed, checkpoint))
        throw new Error("Created issue failed identity/content verification");
      checkpoint.phase = "verified";
      checkpoint.issue = observed;
      await atomicJson(path, checkpoint);
      return {
        status: "created",
        issueUrl: observed.html_url,
        reason: "POST completed and independent GET verified the issue",
      };
    } catch (error) {
      return {
        status: "unknown",
        issueUrl: null,
        reason: `Issue write outcome requires reconciliation: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });
}
export function parseIssueOutcome(output: string): IssueOutcome | undefined {
  try {
    const text = output.trim();
    const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(text);
    return issueOutcome.parse(JSON.parse(fenced ? fenced[1]! : text));
  } catch {
    return undefined;
  }
}
export const issueDigest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

// GitHub's list endpoint can briefly omit a just-created issue. Read-only
// reconciliation may wait for visibility; an unresolved deadline never retries POST.
export async function reconcileIssueWithDeadline(
  target: IssueTarget,
  forge: IssueForge,
  path: string,
  options = { waitMs: 10000, delayMs: 500 },
): Promise<IssueOutcome> {
  if (
    !Number.isFinite(options.waitMs) ||
    options.waitMs < 0 ||
    !Number.isFinite(options.delayMs) ||
    options.delayMs <= 0
  )
    throw new Error("Invalid reconciliation deadline");
  const deadline = Date.now() + options.waitMs;
  let observed = await reconcileIssue(target, forge, path);
  while (observed.status === "unknown" && Date.now() < deadline) {
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.min(options.delayMs, Math.max(0, deadline - Date.now())),
      ),
    );
    if (Date.now() >= deadline) break;
    observed = await reconcileIssue(target, forge, path);
  }
  return observed;
}
