import { realpath } from "node:fs/promises";

// The profile denies reads under /Users, where the selected node binary often
// lives (a version manager or a per-user install). Run that binary by its real
// path and allow reading that one file, so nothing else under /Users opens up.
export async function nodeSandbox(node: string) {
  const binary = await realpath(node);
  return [
    "/usr/bin/sandbox-exec",
    "-p",
    `(version 1)(allow default)(deny network*)(deny file-write*)(deny file-read* (subpath "/Users"))(allow file-read* (literal ${JSON.stringify(binary)}))`,
    binary,
  ];
}
