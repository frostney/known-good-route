// Response.text() applies BOM removal. Process output is byte data, not an HTTP
// text resource: preserve it before decoding and retain raw bytes for oracles.
export async function readProcessBytes(stream: ReadableStream<Uint8Array>) {
  return Buffer.from(await new Response(stream).arrayBuffer());
}
export async function readProcessText(stream: ReadableStream<Uint8Array>) {
  const bytes = await readProcessBytes(stream);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes))
    throw new Error(
      "Process output is not valid UTF-8; do not accept replacement characters as evidence",
    );
  return text;
}
