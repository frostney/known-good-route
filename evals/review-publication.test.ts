import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishReview, reconcilePublishedReview, type ReviewForge, type ReviewRequest } from "./review-publication.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "kgr-review-publish-")); dirs.push(dir);
  const path = join(dir, "intent.json");
  const request: ReviewRequest = { repository: "frostney/kgr-eval-20260906-tests", repositoryId: 42, pr: 4,
    head: "a".repeat(40), actor: "frostney", operation: "review-operation-1", attempt: "native-attempt-1",
    revision: "source-digest", model: "native-test-model", body: "Actual review finding.",
    comments: [{ path: "src/store.mjs", line: 6, side: "RIGHT", body: "Stored false is incorrectly absent." }] };
  const remote = { reviews: [] as any[], comments: [] as any[], posts: 0, hidden: false, head: request.head, actor: request.actor };
  const forge: ReviewForge = {
    identity: async () => ({ id: 42, full_name: request.repository, private: true }), actor: async () => remote.actor,
    head: async () => remote.head, list: async () => structuredClone(remote.hidden ? [] : remote.reviews),
    get: async id => structuredClone(remote.reviews.find(v => v.id === id)),
    comments: async id => structuredClone(remote.comments.filter(v => v.pull_request_review_id === id)),
    comment: async id => structuredClone(remote.comments.find(v => v.id === id)),
    create: async body => {
      remote.posts++;
      const id = remote.posts * 100;
      const review = { id, node_id: `review-${id}`, pull_request_url: `https://api.github.com/repos/${request.repository}/pulls/4`,
        user: { login: remote.actor }, commit_id: body.commit_id, state: "COMMENTED", submitted_at: "2026-09-06T00:00:00Z", body: body.body };
      remote.reviews.push(review);
      remote.comments.push(...body.comments.map((c, i) => ({ ...c, id: id + i + 1,
        pull_request_url: review.pull_request_url, user: review.user, pull_request_review_id: id, original_commit_id: body.commit_id })));
      return { id: -1 }; // The POST response is deliberately not a valid receipt.
    },
  };
  return { path, request, remote, forge };
}

test("review publication verifies independent reads and reuses one durable operation", async () => {
  const f = await fixture();
  expect((await publishReview(f.request, f.forge, f.path)).state).toBe("verified");
  expect((await publishReview(f.request, f.forge, f.path)).review.id).toBe(100);
  expect(f.remote.posts).toBe(1);
});
test("lost accepted response is reconciled without reposting", async () => {
  const f = await fixture(), create = f.forge.create;
  f.forge.create = async body => { await create(body); throw Error("connection lost"); };
  expect((await publishReview(f.request, f.forge, f.path)).state).toBe("verified");
  expect(f.remote.posts).toBe(1);
});
test("delayed visibility remains pending and later recovers the same review", async () => {
  const f = await fixture();
  expect((await publishReview(f.request, f.forge, f.path, { afterAccepted: async () => { f.remote.hidden = true; } })).state).toBe("pending");
  expect((await publishReview(f.request, f.forge, f.path)).state).toBe("pending");
  f.remote.hidden = false;
  expect((await publishReview(f.request, f.forge, f.path)).state).toBe("verified");
  expect(f.remote.posts).toBe(1);
});
test("an interruption after claiming but before POST never silently resends", async () => {
  const f = await fixture();
  await expect(publishReview(f.request, f.forge, f.path, { afterClaim: async () => { throw Error("interrupted"); } })).rejects.toThrow("interrupted");
  expect((await publishReview(f.request, f.forge, f.path)).state).toBe("pending");
  expect(f.remote.posts).toBe(0);
});
test("competing coordinators share one exclusive POST claim", async () => {
  const f = await fixture();
  await Promise.all(Array.from({ length: 12 }, () => publishReview(f.request, f.forge, f.path)));
  expect(f.remote.posts).toBe(1);
  expect((await reconcilePublishedReview(f.request, f.forge, f.path)).state).toBe("verified");
});
test("request changes cannot reuse the same durable operation", async () => {
  const f = await fixture(); await publishReview(f.request, f.forge, f.path);
  for (const patch of [{ body: "edited" }, { pr: 5 }, { head: "b".repeat(40) }, { actor: "someone" },
    { attempt: "other" }, { model: "other" }, { revision: "other" }, { repositoryId: 43 }, { operation: "another-operation" },
    { comments: [{ ...f.request.comments[0]!, line: 7 }] }])
    await expect(publishReview({ ...f.request, ...patch }, f.forge, f.path)).rejects.toThrow("different request");
  expect(f.remote.posts).toBe(1);
});
test("wrong repository or authenticated actor is rejected before posting", async () => {
  const f = await fixture(); f.remote.actor = "someone";
  await expect(publishReview(f.request, f.forge, f.path)).rejects.toThrow("author changed");
  f.remote.actor = f.request.actor;
  f.forge.identity = async () => ({ id: 43, full_name: f.request.repository, private: true });
  await expect(publishReview(f.request, f.forge, f.path)).rejects.toThrow("repository identity");
  expect(f.remote.posts).toBe(0);
});
test("head drift before and after POST cannot establish completion", async () => {
  const f = await fixture(); f.remote.head = "b".repeat(40);
  expect((await publishReview(f.request, f.forge, f.path)).state).toBe("invalidated");
  expect(f.remote.posts).toBe(0); f.remote.head = f.request.head;
  const result = await publishReview(f.request, f.forge, f.path, { afterAccepted: async () => { f.remote.head = "b".repeat(40); } });
  expect(result.state).toBe("invalidated"); expect(result.review.id).toBe(100);
  expect(f.remote.posts).toBe(1);
});
test("author/head changes after the claim prevent a POST", async () => {
  for (const field of ["actor", "head"] as const) {
    const f = await fixture();
    try { await publishReview(f.request, f.forge, f.path, { afterClaim: async () => { f.remote[field] = "changed"; } }); } catch {}
    expect(f.remote.posts).toBe(0);
    f.remote[field] = f.request[field];
    expect((await publishReview(f.request, f.forge, f.path)).state).toBe("pending");
  }
});
test("a copied marker without intent does not authorize adoption or another POST", async () => {
  const f = await fixture(); await publishReview(f.request, f.forge, f.path);
  await expect(publishReview(f.request, f.forge, `${f.path}.other`)).rejects.toThrow("without this operation");
  expect(f.remote.posts).toBe(1);
});
test("duplicate markers and duplicate paginated IDs are rejected", async () => {
  for (const duplicateId of [true, false]) {
    const f = await fixture(); await publishReview(f.request, f.forge, f.path);
    f.remote.reviews.push({ ...f.remote.reviews[0], id: duplicateId ? 100 : 200 });
    await expect(publishReview(f.request, f.forge, f.path)).rejects.toThrow(duplicateId ? "duplicated" : "Multiple reviews");
    expect(f.remote.posts).toBe(1);
  }
});
test("tampered or cross-scope review receipts cannot be reused", async () => {
  for (const patch of [{ id: 200 }, { pull_request_url: "https://api.github.com/repos/other/repo/pulls/4" },
    { user: { login: "someone" } }, { commit_id: "b".repeat(40) }, { body: "edited" }, { state: "PENDING" }, { submitted_at: null }]) {
    const f = await fixture(); await publishReview(f.request, f.forge, f.path);
    const get = f.forge.get; f.forge.get = async id => ({ ...await get(id), ...patch });
    await expect(publishReview(f.request, f.forge, f.path)).rejects.toThrow("does not match");
    expect(f.remote.posts).toBe(1);
  }
});
test("every inline comment must match its actual body, location, actor and review", async () => {
  for (const patch of [{ id: 900 }, { body: "edited" }, { path: "other.mjs" }, { line: 7 }, { side: "LEFT" },
    { user: { login: "someone" } }, { pull_request_review_id: 200 }, { original_commit_id: "b".repeat(40) },
    { in_reply_to_id: 99 }, { pull_request_url: "https://api.github.com/repos/other/repo/pulls/4" }]) {
    const f = await fixture(); await publishReview(f.request, f.forge, f.path);
    const get = f.forge.comment; f.forge.comment = async id => ({ ...await get(id), ...patch });
    await expect(publishReview(f.request, f.forge, f.path)).rejects.toThrow("inline comment");
    expect(f.remote.posts).toBe(1);
  }
});
test("missing or surplus inline comments prevent receipt verification", async () => {
  for (const extra of [true, false]) {
    const f = await fixture(); await publishReview(f.request, f.forge, f.path);
    if (extra) f.remote.comments.push({ ...f.remote.comments[0], id: 102 }); else f.remote.comments = [];
    await expect(publishReview(f.request, f.forge, f.path)).rejects.toThrow("exactly the intended");
  }
});
test("changes during verification are detected by a fresh review census", async () => {
  const f = await fixture(); await publishReview(f.request, f.forge, f.path);
  const get = f.forge.comment;
  f.forge.comment = async id => { f.remote.reviews[0].body = "edited"; return get(id); };
  await expect(publishReview(f.request, f.forge, f.path)).rejects.toThrow("changed during");
});
