import { expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { command } from "./github-live.ts";
import { ownedProcessGroup, requireGroupStopped } from "./process-group.ts";

test("inherited Git interception pauses a real push after acceptance and before its caller returns", async () => {
  const root = await mkdtemp(join(tmpdir(), "kgr-partial-git-")), repo = join(root, "repository"), remote = join(root, "remote.git");
  const realGit = await realpath(Bun.which("git")!), bin = join(root, "bin");
  const git = (...args: string[]) => command([realGit, ...args], repo);
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let owner: Awaited<ReturnType<typeof ownedProcessGroup>> | undefined;
  let reaped = false;
  try {
    await mkdir(repo); await mkdir(bin);
    await command([realGit, "init", "--bare", "--initial-branch=main", remote]);
    await git("init", "--initial-branch=main");
    await git("config", "user.name", "Fixture"); await git("config", "user.email", "fixture@example.invalid");
    await git("remote", "add", "origin", remote);
    await git("commit", "--allow-empty", "-m", "local transport fixture");
    const head = await git("rev-parse", "HEAD"), branch = "codex/eval-partial-local";
    await git("switch", "-c", branch);
    const boundaryPath = join(root, "partial-boundary.json"), config = join(root, "config.json");
    await Bun.write(config, JSON.stringify({ realGit, head, boundaryPath, context: { branch, directory: repo } }));
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    await Bun.write(join(bin, "git"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(import.meta.dir, "stack-partial-git.ts"))} ${quote(config)} "$@"\n`);
    await chmod(join(bin, "git"), 0o755);
    // The environment must be supplied at worker creation. Changing Bun's
    // process.env.PATH afterwards did not reach its default-env children.
    const script = `import { command } from ${JSON.stringify(join(import.meta.dir, "github-live.ts"))};
      await command(["git", "--version"], ${JSON.stringify(repo)});
      await command(["git", "push", "origin", ${JSON.stringify(`refs/heads/${branch}:refs/heads/${branch}`)}], ${JSON.stringify(repo)});
      await Bun.write(${JSON.stringify(join(root, "caller-returned"))}, "unexpected");`;
    child = Bun.spawn([process.execPath, "-e", script], { detached: true,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "ignore", stderr: "ignore" });
    owner = await ownedProcessGroup(child.pid);
    const deadline = Date.now() + 10000;
    while (!await Bun.file(boundaryPath).exists() && child.exitCode === null && Date.now() < deadline) await Bun.sleep(25);
    expect(await Bun.file(join(root, "interception-probe.json")).exists()).toBe(true);
    expect(await Bun.file(boundaryPath).exists()).toBe(true);
    expect((await Bun.file(boundaryPath).json()).head).toBe(head);
    expect(await git("ls-remote", "--heads", "origin", `refs/heads/${branch}`)).toBe(`${head}\trefs/heads/${branch}`);
    expect(child.exitCode).toBeNull();
    expect(await Bun.file(join(root, "caller-returned")).exists()).toBe(false);
    process.kill(-owner.group, "SIGKILL");
    const exit = await child.exited; reaped = true;
    expect(exit).toBe(137);
    await requireGroupStopped(owner);
  } finally {
    if (child && owner && !reaped) {
      process.kill(-owner.group, "SIGKILL"); await child.exited; await requireGroupStopped(owner);
    }
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
