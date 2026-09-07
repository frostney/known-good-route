import { expect, test } from "bun:test";
import { inspectionPager, inspectionPageSize } from "./inspection-pages.ts";
import { digest } from "./github-live.ts";

test("large inspection evidence is reconstructed completely from bounded pages", () => {
  const evidence = { source: '"\\\n雪'.repeat(20000), reviews: [{ id: 42, finding: "late finding" }] };
  const pager = inspectionPager(); let page = pager.capture(evidence), text = "", count = 0;
  const id = page.snapshotId;
  while (true) {
    expect(page.text.length).toBeLessThanOrEqual(inspectionPageSize);
    expect(JSON.stringify(page).length).toBeLessThan(13000);
    expect(page.snapshotId).toBe(id);
    text += page.text; count++;
    if (page.nextOffset === null) { expect(page.complete).toBe(true); break; }
    expect(page.complete).toBe(false);
    page = pager.read(id, page.nextOffset);
  }
  expect(count).toBeGreaterThan(10);
  expect(JSON.parse(text)).toEqual(evidence);
  expect(digest(text)).toBe(id);
});
test("small inspections complete in one page", () => {
  const page = inspectionPager().capture({ ready: true });
  expect(page.complete).toBe(true); expect(page.nextOffset).toBeNull();
});
test("skipping to the end cannot count as complete evidence inspection", () => {
  const pager = inspectionPager(), first = pager.capture({ data: "x".repeat(inspectionPageSize * 4) });
  expect(() => pager.read(first.snapshotId, inspectionPageSize * 4)).toThrow("sequentially");
  const second = pager.read(first.snapshotId, first.nextOffset!);
  expect(second.complete).toBe(false);
});
test("rereading a page is idempotent and does not move the completion boundary", () => {
  const pager = inspectionPager(), first = pager.capture({ data: "x".repeat(inspectionPageSize * 2) });
  expect(pager.read(first.snapshotId, 0)).toEqual(first);
  const second = pager.read(first.snapshotId, first.nextOffset!);
  expect(pager.read(first.snapshotId, second.offset)).toEqual(second);
});
test("new capture invalidates earlier cursors and freezes mutable input", () => {
  const pager = inspectionPager(), value = { text: "before" };
  const first = pager.capture(value); value.text = "after";
  expect(pager.read(first.snapshotId, 0).text).toContain("before");
  const next = pager.capture(value);
  expect(() => pager.read(first.snapshotId, 0)).toThrow("unavailable");
  expect(next.text).toContain("after");
});
test("invalid, unaligned and out-of-range offsets are rejected", () => {
  const pager = inspectionPager(), first = pager.capture({ data: "x".repeat(inspectionPageSize * 2) });
  for (const offset of [-1, 1, 0.5, Infinity, first.totalCharacters, inspectionPageSize * 3])
    expect(() => pager.read(first.snapshotId, offset)).toThrow("Invalid inspection offset");
});
