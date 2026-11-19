import { realpath } from "node:fs/promises";

// The profile denies reads under /Users, which includes reading a symlink
// there, such as a per-user bin entry pointing at the selected node. Executing
// the binary itself is still allowed, so run it by its real path.
export async function nodeSandbox(node: string) {
  return [
    "/usr/bin/sandbox-exec",
    "-p",
    '(version 1)(allow default)(deny network*)(deny file-write*)(deny file-read* (subpath "/Users"))',
    await realpath(node),
  ];
}
