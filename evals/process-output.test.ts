import { test, expect } from "bun:test";
import { readProcessText, readProcessBytes } from "./process-output.ts";
const stream = (hex: string) => new Response(Buffer.from(hex, "hex")).body!;
test("process text preserves a leading BOM, NUL and newline exactly", async () => {
  expect(await readProcessText(stream("efbbbf000a"))).toBe("\ufeff\0\n");
  expect((await readProcessBytes(stream("efbbbf000a"))).toString("hex")).toBe(
    "efbbbf000a",
  );
});
test("invalid bytes cannot masquerade as a valid Unicode replacement character", async () => {
  await expect(readProcessText(stream("ff0a"))).rejects.toThrow(
    "not valid UTF-8",
  );
  expect((await readProcessBytes(stream("ff0a"))).toString("hex")).toBe("ff0a");
  expect(await readProcessText(stream("efbfbd0a"))).toBe("\ufffd\n");
});
