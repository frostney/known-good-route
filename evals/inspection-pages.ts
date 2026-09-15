import { digest } from "./github-live.ts";

// Leave room for JSON escaping and native tool metadata below output limits.
export const inspectionPageSize = 6000;
export function inspectionPager() {
  let active: { id: string; text: string; readThrough: number } | undefined;
  function read(snapshotId: string, offset: number) {
    if (!active || snapshotId !== active.id) throw Error("Inspection snapshot is unavailable; start a fresh inspection");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= active.text.length || offset % inspectionPageSize !== 0)
      throw Error("Invalid inspection offset; use the returned nextOffset");
    if (offset > active.readThrough) throw Error("Read inspection pages sequentially without skipping evidence");
    const end = Math.min(offset + inspectionPageSize, active.text.length);
    active.readThrough = Math.max(active.readThrough, end);
    return { snapshotId: active.id, encoding: "JSON text", offset, totalCharacters: active.text.length,
      nextOffset: end < active.text.length ? end : null,
      complete: active.readThrough === active.text.length, text: active.text.slice(offset, end) };
  }
  return {
    capture(value: unknown) {
      const text = JSON.stringify(value);
      if (!text) throw Error("Inspection must have serializable evidence");
      active = { id: digest(text), text, readThrough: 0 };
      return read(active.id, 0);
    },
    read,
  };
}
