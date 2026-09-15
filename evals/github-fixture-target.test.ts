import { expect, test } from "bun:test";
import { fixtureCommand, fixtureEnvironment } from "./github-fixture-target.ts";

const repository = "frostney/kgr-eval-20260906-host-binding";

test("fixture subprocesses override ambient targets without modifying login configuration", async () => {
  const environment = { ...process.env, GH_HOST: "unrelated.invalid", GH_REPO: "unrelated.invalid/other/repo",
    GH_CONFIG_DIR: "/fixture/saved-login-location", KGR_TEST_MARKER: "preserved" };
  const original = { ...environment };
  const run = fixtureCommand(repository);
  const result = JSON.parse(await run([process.execPath, "-e",
    'console.log(JSON.stringify({host:process.env.GH_HOST,repo:process.env.GH_REPO,config:process.env.GH_CONFIG_DIR,marker:process.env.KGR_TEST_MARKER}))'],
    undefined, undefined, environment));
  expect(result).toEqual({ host: "github.com", repo: `github.com/${repository}`, config: environment.GH_CONFIG_DIR, marker: "preserved" });
  expect(environment).toEqual(original);
});

test("API reads and writes bind the same explicit host and retain exact input", async () => {
  const calls: { argv: string[]; input: string | undefined; environment: NodeJS.ProcessEnv | undefined }[] = [];
  const run = fixtureCommand(repository, async (argv, _cwd, input, environment) => {
    calls.push({ argv, input, environment }); return "{}";
  });
  await run(["gh", "api", `repos/${repository}`]);
  await run(["gh", "api", `repos/${repository}/pulls`, "--method", "POST", "--input", "-", "--hostname", "github.com"], undefined, '{"draft":true}');
  for (const call of calls) {
    expect(call.argv.filter(a => a === "--hostname")).toHaveLength(1);
    expect(call.argv[call.argv.indexOf("--hostname") + 1]).toBe("github.com");
    expect(call.environment?.GH_HOST).toBe("github.com");
    expect(call.environment?.GH_REPO).toBe(`github.com/${repository}`);
  }
  expect(calls[1]!.input).toBe('{"draft":true}');
});

test("conflicting API host arguments reject before launching a process", async () => {
  let calls = 0;
  const run = fixtureCommand(repository, async () => { calls++; return ""; });
  for (const flags of [["--hostname", "other.invalid"], ["--hostname=other.invalid"], ["--hostname"],
    ["--hostname", "github.com", "--hostname=github.com"]])
    await expect(run(["gh", "api", `repos/${repository}`, ...flags])).rejects.toThrow("host differs");
  expect(calls).toBe(0);
  expect(() => fixtureEnvironment("other/repo")).toThrow("Invalid GitHub fixture target");
});
