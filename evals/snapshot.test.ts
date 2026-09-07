import { test, expect } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { treeManifest, installSnapshotDependencies } from "./snapshot.ts";
import { digest } from "./github-live.ts";
test("a broad nested tree retains every file, directory, mode and internal link", async () => {
  const root = await mkdtemp(join(tmpdir(), "kgr-snapshot-nested-"));
  try {
    await Promise.all(Array.from({ length: 48 }, async (_, index) => {
      const dir = join(root, `branch-${index}`, "nested"); await mkdir(dir, { recursive: true });
      await Bun.write(join(dir, ".payload"), `bytes-${index}`);
      await chmod(join(dir, ".payload"), 0o700);
      await symlink(".payload", join(dir, "link"));
    }));
    const manifest = await treeManifest(root);
    expect(Object.keys(manifest).length).toBe(48 * 4);
    for (let index = 0; index < 48; index++) {
      expect(manifest[`branch-${index}/nested`]?.type).toBe("directory");
      expect(manifest[`branch-${index}/nested/.payload`]).toEqual({ type: "file", mode: 0o700, sha256: digest(`bytes-${index}`) });
      expect(manifest[`branch-${index}/nested/link`]).toEqual({ type: "symlink", mode: 0o777, target: ".payload" });
    }
    await symlink("/tmp", join(root, "branch-47/nested/escape"));
    await expect(treeManifest(root)).rejects.toThrow("escapes");
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("snapshot manifest includes executable modes and hidden files and rejects dependency escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "kgr-snapshot-tree-"));
  try {
    await Bun.write(join(root, ".hidden"), "evidence");
    await chmod(join(root, ".hidden"), 0o755);
    const before = await treeManifest(root);
    expect(before[".hidden"]?.mode).toBe(0o755);
    await symlink(".hidden", join(root, "local-link"));
    expect((await treeManifest(root))["local-link"]?.target).toBe(".hidden");
    await symlink("/tmp", join(root, "escape"));
    await expect(treeManifest(root)).rejects.toThrow("escapes");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("dependency installation uses the lock without running package lifecycle scripts", async () => {
  const root = await mkdtemp(join(tmpdir(), "kgr-snapshot-install-"));
  try {
    const manifest = await Bun.file(
      resolve(import.meta.dir, "../package.json"),
    ).json();
    manifest.scripts.postinstall = "touch forbidden-marker";
    await Bun.write(join(root, "package.json"), JSON.stringify(manifest));
    await Bun.write(
      join(root, "bun.lock"),
      await Bun.file(resolve(import.meta.dir, "../bun.lock")).bytes(),
    );
    const installed = await installSnapshotDependencies(root);
    expect(await Bun.file(join(root, "forbidden-marker")).exists()).toBe(false);
    expect(installed["zod/package.json"]?.sha256).toBeDefined();
    const original = await Bun.file(
      resolve(import.meta.dir, "../node_modules/zod/package.json"),
    ).text();
    await Bun.write(
      join(root, "node_modules/zod/package.json"),
      "snapshot-only mutation",
    );
    expect(
      await Bun.file(
        resolve(import.meta.dir, "../node_modules/zod/package.json"),
      ).text(),
    ).toBe(original);
    expect(
      (await treeManifest(join(root, "node_modules")))["zod/package.json"]
        ?.sha256,
    ).not.toBe(installed["zod/package.json"]?.sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
// Installs and hashes the real locked dependency tree twice. Successful local
// runs exceed the default five seconds; keep a bounded integration allowance.
}, 30_000);
