import { command } from "./github-live.ts";

// The native eval fixture inventory is github.com-only. This pins inherited
// CLI defaults; callers must still construct scoped endpoints and numeric PR
// arguments. It is not a sandbox for arbitrary commands, URLs or credentials.
export function fixtureEnvironment(repository: string, environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!/^frostney\/kgr-eval-\d{8}-[a-z0-9-]+$/.test(repository)) throw Error("Invalid GitHub fixture target");
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
