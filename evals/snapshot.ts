import { cp, mkdir, readdir, readlink, realpath, stat } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { loadSkills } from "./skill-loader.ts";
import { readProcessText } from "./process-output.ts";
export interface TreeEntry {
  type: "file" | "directory" | "symlink";
  mode: number;
  sha256?: string;
  target?: string;
}
export async function treeManifest(
  root: string,
): Promise<Record<string, TreeEntry>> {
  const entries: Record<string, TreeEntry> = {};
  const canonicalRoot = await realpath(root);
  // Bound filesystem concurrency across the whole recursive walk. A serial
  // await per entry makes frozen dependency verification sensitive to host load.
  let active = 0;
  const waiting: (() => void)[] = [];
  async function limited<T>(work: () => Promise<T>): Promise<T> {
    if (active >= 16) await new Promise<void>(ready => waiting.push(ready));
    else active++;
    try { return await work(); }
    finally {
      const next = waiting.shift();
      if (next) next(); else active--;
    }
  }
  async function walk(dir: string) {
    const items = await limited(() => readdir(dir, { withFileTypes: true }));
    const results = await Promise.allSettled(items.map(async item => {
      const path = join(dir, item.name),
        key = relative(root, path);
      await limited(async () => {
        if (item.isSymbolicLink()) {
          const target = await realpath(path),
            rel = relative(canonicalRoot, target);
          if (rel === ".." || rel.startsWith("../") || isAbsolute(rel))
            throw new Error(`Snapshot symlink escapes its tree: ${key}`);
          entries[key] = {
            type: "symlink",
            mode: 0o777,
            target: await readlink(path),
          };
        } else {
          const mode = (await stat(path)).mode & 0o7777;
          if (item.isDirectory()) {
            entries[key] = { type: "directory", mode };
          } else if (item.isFile())
            entries[key] = {
              type: "file",
              mode,
              sha256: createHash("sha256")
                .update(await Bun.file(path).bytes())
                .digest("hex"),
            };
          else throw new Error(`Unsupported snapshot entry: ${key}`);
        }
      });
      // Release the slot before recursion so nested directories cannot deadlock.
      if (item.isDirectory()) await walk(path);
    }));
    // Drain all owned work before returning an error or allowing fixture cleanup.
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
  await walk(root);
  return Object.fromEntries(
    Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)),
  );
}
export async function installSnapshotDependencies(snapshot: string) {
  const lock = await Bun.file(join(snapshot, "bun.lock")).bytes();
  const p = Bun.spawn(
    [
      process.execPath,
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--backend=copyfile",
    ],
    { cwd: snapshot, stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, code] = await Promise.all([
    readProcessText(p.stdout),
    readProcessText(p.stderr),
    p.exited,
  ]);
  await Bun.write(join(snapshot, "dependency-install.stdout"), out);
  await Bun.write(join(snapshot, "dependency-install.stderr"), err);
  if (code)
    throw new Error(
      "Frozen dependency install failed; inspect retained install logs",
    );
  if (
    !Buffer.from(lock).equals(
      Buffer.from(await Bun.file(join(snapshot, "bun.lock")).bytes()),
    )
  )
    throw new Error("Frozen dependency install changed its lock");
  const dependencies = await treeManifest(join(snapshot, "node_modules"));
  await Bun.write(
    join(snapshot, "dependencies-manifest.json"),
    JSON.stringify(dependencies, null, 2) + "\n",
  );
  return dependencies;
}
export async function freezeSnapshot(
  snapshot: string,
  skillsRoot = process.cwd(),
  harnessRoot = import.meta.dir,
) {
  await mkdir(snapshot);
  for (const skill of (await loadSkills(skillsRoot)).values())
    await cp(skill.directory, join(snapshot, skill.name), { recursive: true });
  await cp(harnessRoot, join(snapshot, "evals"), { recursive: true });
  for (const name of ["package.json", "bun.lock", "tsconfig.json"])
    await cp(resolve(harnessRoot, "..", name), join(snapshot, name));
  await installSnapshotDependencies(snapshot);
  const all = await treeManifest(snapshot);
  const hashes = Object.fromEntries(
    Object.entries(all)
      .filter(
        ([path, entry]) =>
          !path.startsWith("node_modules/") && entry.type === "file",
      )
      .map(([path, entry]) => [path, entry.sha256!]),
  );
  await Bun.write(
    join(snapshot, "manifest.json"),
    JSON.stringify(hashes, null, 2) + "\n",
  );
  return { hashes, dependencies: join(snapshot, "dependencies-manifest.json") };
}
