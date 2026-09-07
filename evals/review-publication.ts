import { z } from "zod";
import { issueDigest } from "./issue-receipt.ts";
import { claimOperation, matchingIntent } from "./operation-intent.ts";

const requestSchema = z.object({
  repository: z.string().regex(/^frostney\/kgr-eval-\d{8}-[a-z0-9-]+$/),
  repositoryId: z.number().int().positive(), pr: z.number().int().positive(),
  head: z.string().regex(/^[0-9a-f]{40}$/), actor: z.string().min(1),
  operation: z.string().regex(/^[a-zA-Z0-9-]{8,100}$/),
  attempt: z.string().min(1), revision: z.string().min(1), model: z.string().min(1),
  body: z.string().min(1), comments: z.array(z.object({
    path: z.string().min(1), line: z.number().int().positive(),
    side: z.literal("RIGHT"), body: z.string().min(1),
  }).strict()),
}).strict();
export type ReviewRequest = z.infer<typeof requestSchema>;
export interface ReviewForge {
  identity(): Promise<{ id: number; full_name: string; private: boolean }>;
  actor(): Promise<string>;
  head(): Promise<string>;
  list(): Promise<any[]>;
  get(id: number): Promise<any>;
  comments(id: number): Promise<any[]>;
  comment(id: number): Promise<any>;
  create(body: { event: "COMMENT"; commit_id: string; body: string; comments: ReviewRequest["comments"] }): Promise<unknown>;
}
export const reviewOperationMarker = (r: ReviewRequest) => `<!-- kgr-review-operation:${r.operation} -->`;
export const reviewRequestBody = (r: ReviewRequest) => `${r.body}\n\n${reviewOperationMarker(r)}\n<!-- kgr-review-request:${issueDigest(requestSchema.parse(r))} -->`;
export interface PublishedReview {
  state: "verified" | "pending" | "invalidated";
  reason: string;
  review?: any;
  comments?: any[];
}
const readIntent = matchingIntent;
const claimIntent = claimOperation;
async function identity(r: ReviewRequest, forge: ReviewForge) {
  const v = await forge.identity();
  if (v.id !== r.repositoryId || v.full_name !== r.repository || !v.private)
    throw Error("Review repository identity changed");
}
function unique(rows: any[], label: string) {
  if (!Array.isArray(rows) || rows.some(v => !Number.isSafeInteger(v.id) || v.id <= 0) ||
      new Set(rows.map(v => v.id)).size !== rows.length) throw Error(`Incomplete or duplicated ${label}`);
  return rows;
}
async function observe(r: ReviewRequest, forge: ReviewForge): Promise<PublishedReview> {
  await identity(r, forge);
  const matches = unique(await forge.list(), "review census").filter(v => String(v.body ?? "").includes(reviewOperationMarker(r)));
  if (matches.length > 1) throw Error("Multiple reviews carry this operation marker");
  if (!matches.length) return { state: "pending", reason: "No verified receipt is visible; another POST is not authorized" };
  const review = await forge.get(matches[0].id);
  const url = `https://api.github.com/repos/${r.repository}/pulls/${r.pr}`;
  if (review.id !== matches[0].id || review.pull_request_url !== url || review.user?.login !== r.actor ||
      review.commit_id !== r.head || review.body !== reviewRequestBody(r) || review.state !== "COMMENTED" || !review.submitted_at)
    throw Error("Published review scope, author, head or content does not match the intent");
  const listed = unique(await forge.comments(review.id), "review comments");
  if (listed.length !== r.comments.length) throw Error("Published review does not contain exactly the intended comments");
  const remaining = r.comments.map(v => JSON.stringify(v)), comments = [];
  for (const item of listed) {
    const v = await forge.comment(item.id);
    if (v.id !== item.id || v.pull_request_url !== url || v.user?.login !== r.actor ||
        v.pull_request_review_id !== review.id || v.original_commit_id !== r.head || v.in_reply_to_id != null)
      throw Error("Published inline comment has a different scope or identity");
    const index = remaining.indexOf(JSON.stringify({ path: v.path, line: v.line, side: v.side, body: v.body }));
    if (index < 0) throw Error("Published inline comment body or location differs from the intent");
    remaining.splice(index, 1); comments.push(v);
  }
  // Refresh the review census after fetching its members; never combine a
  // changed body or new duplicate marker with the earlier receipt.
  const refreshed = unique(await forge.list(), "review census").filter(v => String(v.body ?? "").includes(reviewOperationMarker(r)));
  if (refreshed.length !== 1 || refreshed[0].id !== review.id || refreshed[0].body !== review.body ||
      refreshed[0].state !== review.state || refreshed[0].commit_id !== review.commit_id)
    throw Error("Review changed during receipt verification");
  if (await forge.head() !== r.head) return { state: "invalidated", reason: "Review exists, but the current PR head changed", review, comments };
  return { state: "verified", reason: "Independent reads verified the review and every intended inline comment", review, comments };
}
export async function reconcilePublishedReview(request: ReviewRequest, forge: ReviewForge, path: string): Promise<PublishedReview> {
  const r = requestSchema.parse(request);
  if (!await readIntent(path, r)) return { state: "pending", reason: "No durable review intent exists" };
  return observe(r, forge);
}
export async function publishReview(request: ReviewRequest, forge: ReviewForge, path: string,
  hooks: { afterClaim?: () => Promise<void>; afterAccepted?: () => Promise<void> } = {}): Promise<PublishedReview> {
  const r = requestSchema.parse(request);
  if (await readIntent(path, r)) return observe(r, forge);
  await identity(r, forge);
  if (await forge.head() !== r.head) return { state: "invalidated", reason: "PR head changed before publication" };
  if (await forge.actor() !== r.actor) throw Error("Authenticated review author changed");
  if (unique(await forge.list(), "review census").some(v => String(v.body ?? "").includes(reviewOperationMarker(r)))) {
    if (await readIntent(path, r)) return observe(r, forge);
    throw Error("A review marker exists without this operation's durable intent");
  }
  if (!await claimIntent(path, r)) return observe(r, forge);
  await hooks.afterClaim?.();
  if (await forge.head() !== r.head) return { state: "invalidated", reason: "PR head changed after claiming publication" };
  if (await forge.actor() !== r.actor) throw Error("Authenticated review author changed before POST");
  try {
    await forge.create({ event: "COMMENT", commit_id: r.head, body: reviewRequestBody(r), comments: r.comments });
    await hooks.afterAccepted?.();
  } catch { /* A lost response never authorizes another POST. Read actual state. */ }
  return observe(r, forge);
}
