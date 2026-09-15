import { fixtureEnvironment } from "./github-fixture-target.ts";
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command } from "./github-live.ts";
import { absentGitObject, preparePushGuard, runGuardedStack, type PushGuardAdmission } from "./stack-push-guard.ts";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
const ref = "refs/heads/codex/eval-original", fixRef = "refs/heads/codex/eval-fix";
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kgr-push-guard-"))); directories.push(root);
  const directory = join(root, "repository"), remote = join(root, "remote.git"); await mkdir(directory);
  const git = (...args: string[]) => command(["git", ...args], directory);
  await command(["git", "init", "--bare", "--initial-branch=main", remote]);
  await git("init", "--initial-branch=main");
  await git("config", "user.name", "Fixture"); await git("config", "user.email", "fixture@example.invalid");
  await git("commit", "--allow-empty", "-m", "original"); const original = await git("rev-parse", "HEAD");
  await git("branch", "codex/eval-original"); await git("remote", "add", "origin", remote);
  await git("push", "origin", `${ref}:${ref}`);
  await git("commit", "--allow-empty", "-m", "fix"); const fix = await git("rev-parse", "HEAD");
  await git("branch", "codex/eval-fix");
  const admission: PushGuardAdmission = { directory, remote: "origin", url: remote,
    refs: [{ ref, source: original, expected: original }, { ref: fixRef, source: fix, expected: absentGitObject }] };
  const remoteHead = (name = ref) => git("ls-remote", "--heads", "origin", name);
  const guardPush = async (args: string[], c = admission) => {
    const guard = await preparePushGuard(c);
    await command(["git", "push", "origin", ...args], directory, undefined, guard.environment);
    return guard;
  };
  const checks = async (path: string) => Promise.all((await readdir(path)).filter(n => n.startsWith("check-")).map(n => Bun.file(join(path, n)).json()));
  return { root, directory, remote, git, original, fix, admission, remoteHead, guardPush, checks };
}

test("guarded real push permits only admitted original and new heads", async () => {
  const f = await fixture();
  const guard = await f.guardPush([`--force-with-lease=${ref}:${f.original}`, `--force-with-lease=${fixRef}:`, `${ref}:${ref}`, `${fixRef}:${fixRef}`]);
  expect(await f.remoteHead()).toBe(`${f.original}\t${ref}`);
  expect(await f.remoteHead(fixRef)).toBe(`${f.fix}\t${fixRef}`);
  const records = await f.checks(guard.directory);
  expect(records.length).toBe(1); expect(records[0].accepted).toBe(true);
  expect(records[0].updates).toEqual([{ ref: fixRef, source: f.fix, expected: absentGitObject }]);
}, 15000);

test("a refreshed native-style lease can lose an update but the admitted-head guard rejects it", async () => {
  const f = await fixture();
  // All remote writes in this regression test use a disposable local bare repo.
  await f.git("push", "origin", `${f.fix}:${ref}`);
  await f.git("fetch", "origin");
  const refreshed = await f.git("rev-parse", "refs/remotes/origin/codex/eval-original");
  expect(refreshed).toBe(f.fix);
  const args = [`--force-with-lease=${ref}:${refreshed}`, `${ref}:${ref}`];
  await f.git("push", "origin", ...args);
  expect(await f.remoteHead()).toBe(`${f.original}\t${ref}`);
  await f.git("push", "origin", `${f.fix}:${ref}`);
  await expect(f.guardPush(args)).rejects.toThrow("advertised remote head differs");
  expect(await f.remoteHead()).toBe(`${f.fix}\t${ref}`);
}, 15000);

test("changed local source and unexpected existing new branch are rejected before updates", async () => {
  const f = await fixture();
  await f.git("update-ref", ref, f.fix, f.original);
  await expect(f.guardPush([`${ref}:${ref}`])).rejects.toThrow("queued source");
  expect(await f.remoteHead()).toBe(`${f.original}\t${ref}`);
  await f.git("push", "origin", `${f.original}:${fixRef}`);
  await expect(f.guardPush([`--force-with-lease=${fixRef}:${f.original}`, `${fixRef}:${fixRef}`])).rejects.toThrow("advertised remote head");
  expect(await f.remoteHead(fixRef)).toBe(`${f.original}\t${fixRef}`);
}, 15000);

test("existing configured hooks still receive original arguments and input and can veto", async () => {
  const f = await fixture(), hooks = join(f.root, "custom hooks"); await mkdir(hooks);
  await f.git("config", "core.hooksPath", hooks);
  const captured = join(f.root, "hook-input"), args = join(f.root, "hook-args"), hook = join(hooks, "pre-push");
  await Bun.write(hook, `#!/bin/sh\nprintf '%s\\n' "$@" > ${quote(args)}\ncat > ${quote(captured)}\nexit 1\n`); await chmod(hook, 0o755);
  await expect(f.guardPush([`${fixRef}:${fixRef}`])).rejects.toThrow("original pre-push hook rejected");
  expect(await Bun.file(args).text()).toBe(`origin\n${f.remote}\n`);
  expect(await Bun.file(captured).text()).toBe(`${fixRef} ${f.fix} ${fixRef} ${absentGitObject}\n`);
  expect(await f.remoteHead(fixRef)).toBe("");
  expect(await f.git("config", "core.hooksPath")).toBe(hooks);
}, 15000);

test("a remote change after guard validation is rejected by Git's receive-side comparison", async () => {
  const f = await fixture(), hooks = join(f.directory, ".git", "hooks"), hook = join(hooks, "pre-push");
  // Runs after validation inside the chained hook: represents another writer
  // accepting a competing update after this push advertised an absent ref.
  const binary = await realpath(Bun.which("git")!);
  await Bun.write(hook, `#!/bin/sh\n${quote(binary)} --git-dir=${quote(f.remote)} update-ref ${quote(fixRef)} ${quote(f.original)} ${quote(absentGitObject)}\n`);
  await chmod(hook, 0o755);
  await expect(f.guardPush([`--force-with-lease=${fixRef}:`, `${fixRef}:${fixRef}`])).rejects.toThrow("failed");
  expect(await f.remoteHead(fixRef)).toBe(`${f.original}\t${fixRef}`);
}, 15000);



test("bound fixture targets reach the native command through the portable guard", async () => {
  const f = await fixture(), bin = join(f.root, "bin"), output = join(f.root, "target.txt");
  await mkdir(bin);
  const gh = join(bin, "gh");
  await Bun.write(gh, `#!/bin/sh
if [ "$1" = stack ] && [ "$2" = --version ]; then
  printf '%s\\n' 'gh stack version 0.1.0'
  exit 0
fi
printf '%s\\n%s\\n' "$GH_HOST" "$GH_REPO" > "$KGR_HOST_EVIDENCE"
`);
  await chmod(gh, 0o755);
  const repository = "frostney/kgr-eval-20260906-guard-host";
  const environment = fixtureEnvironment(repository, { ...process.env, PATH: `${bin}:${process.env.PATH}`,
    GH_HOST: "other.invalid", GH_REPO: "other.invalid/unrelated/repo", KGR_HOST_EVIDENCE: output });
  await runGuardedStack(f.admission, ["push", "--remote", "origin"], process.env.KGR_PYTHON_BIN ?? "python3", environment);
  expect((await Bun.file(output).text()).trim().split("\n")).toEqual(["github.com", `github.com/${repository}`]);
  // This fake native command tests environment propagation only; it never pushes.
  expect(await f.remoteHead(fixRef)).toBe("");
});
