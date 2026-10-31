import { command } from "./github-live.ts";

const disposableRepository = /^frostney\/kgr-eval-\d{8}-[a-z0-9-]+$/;

// The native eval fixture inventory is github.com-only. This pins inherited
// CLI defaults; callers must still construct scoped endpoints and numeric PR
// arguments. It is not a sandbox for arbitrary commands, URLs or credentials.
export function fixtureEnvironment(repository: string, environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!disposableRepository.test(repository)) throw Error("Invalid GitHub fixture target");
  return { ...environment, GH_HOST: "github.com", GH_REPO: `github.com/${repository}` };
}

export function fixtureCommand(repository: string, run: typeof command = command): typeof command {
  fixtureEnvironment(repository, {}); // Validate before starting any process.
  return async (argv, cwd, input, environment) => {
    let args = argv;
    if (argv[0] === "gh" && argv[1] === "api") {
      const flags = argv.filter(a => a === "--hostname" || a.startsWith("--hostname="));
      if (flags.length > 1 || flags.some(a => a === "--hostname" ? argv[argv.indexOf(a) + 1] !== "github.com" : a !== "--hostname=github.com"))
        throw Error("GitHub API host differs from fixture admission");
      if (!flags.length) args = [...argv, "--hostname", "github.com"];
    }
    return run(args, cwd, input, fixtureEnvironment(repository, environment));
  };
}

// A live run admits the disposable fixture its setup recorded, never a fixed
// repository. The runner still checks the live repository's ID and privacy.
export function disposableFixture(fixture: { repository?: unknown; repositoryId?: unknown }): { repository: string; repositoryId: number } {
  const { repository, repositoryId } = fixture;
  if (typeof repository !== "string" || !disposableRepository.test(repository) ||
      typeof repositoryId !== "number" || !Number.isSafeInteger(repositoryId) || repositoryId <= 0)
    throw Error("Supply a disposable fixture repository and its recorded ID");
  return { repository, repositoryId };
}

// The review comparisons seed feedback on the top layer of a stack that
// stack-live-setup.ts prepared, at the head the setup recorded.
export async function reviewFixture(path: string | undefined): Promise<{ repository: string; repositoryId: number; pr: number; head: string }> {
  if (!path) throw Error("Supply the prepared --fixture stack.json");
  const fixture = await Bun.file(path).json();
  const top = fixture.stack?.pull_requests?.at(-1), head = fixture.localHeads?.at(-1);
  if (!Number.isSafeInteger(top?.number) || typeof head !== "string" || !/^[0-9a-f]{40}$/.test(head))
    throw Error("The fixture records no top stack PR and head");
  return { ...disposableFixture(fixture), pr: top.number, head };
}
