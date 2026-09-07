import { readProcessText } from "./process-output.ts";
import { homedir } from "node:os";
import { mkdtemp, cp, rm, realpath } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { completedReview } from "./review-receipt.ts";
import { resolve } from "node:path";
import { z } from "zod";
import { runLocal, preflight } from "./local-runtime.ts";
import { loadSkills, formatSkillCatalog } from "./skill-loader.ts";
import { createEvalTools } from "./tools.ts";
import type { RunLedger, EvalCase } from "./types.ts";
import { atomicJson } from "./issue-receipt.ts";
import { liveReviewTask, readLiveReviewEvidence } from "./live-review-evidence.ts";

export interface LiveConfig {
  repository: string;
  repositoryId: number;
  directory: string;
  branch: string;
  base: string;
  model: string;
  skillsRoot: string;
  evidence: string;
  nodeBinary?: string;
  reviewAttempt?: { id: string; revision: string };
  issueUrl?: string;
  research: { query: string; searchedAt: string; url: string; summary: string };
}
export const liveCase: EvalCase = {
  id: "github-live-delivery",
  description: "Real disposable GitHub delivery",
  prompt: "",
  fixture: { evidence: {} },
  expected: {},
};
export const digest = (s: string) =>
  createHash("sha256").update(s).digest("hex");
export function validateTarget(c: LiveConfig) {
  if (
    !/^frostney\/kgr-eval-\d{8}-[a-z0-9-]+$/.test(c.repository) ||
    !Number.isSafeInteger(c.repositoryId) ||
    c.repositoryId <= 0 ||
    !/^codex\/eval-[a-z0-9-]+$/.test(c.branch) ||
    !/^[0-9a-f]{40}$/.test(c.base)
  )
    throw new Error(
      "Target must be an explicitly configured disposable repository and branch",
    );
  if (c.issueUrl !== undefined &&
    !new RegExp(`^https://github\\.com/${c.repository}/issues/[1-9][0-9]*$`).test(c.issueUrl))
    throw new Error("Visibility issue must belong to the configured disposable repository");
}
export async function command(argv: string[], cwd?: string, input?: string, environment?: NodeJS.ProcessEnv) {
  const p = Bun.spawn(argv, {
    ...(cwd ? { cwd } : {}),
    ...(environment ? { env: environment } : {}),
    stdin: input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (input !== undefined) {
    (p.stdin as any).write(input);
    (p.stdin as any).end();
  }
  const [stdout, stderr, code] = await Promise.all([
    readProcessText(p.stdout),
    readProcessText(p.stderr),
    p.exited,
  ]);
  if (code)
    throw new Error(
      `${argv[0]} ${argv[1]} failed (${code}): ${stderr.slice(0, 1500)}`,
    );
  return stdout.trim();
}
export async function liveTools(
  configPath: string,
  role: string,
  ledger: RunLedger,
) {
  const c = (await Bun.file(configPath).json()) as LiveConfig;
  validateTarget(c);
  const git = (...args: string[]) => command(["git", ...args], c.directory);
  const api = async (path: string, body?: unknown) =>
    JSON.parse(
      await command(
        [
          "gh",
          "api",
          `repos/${c.repository}/${path}`,
          ...(body ? ["--method", "POST", "--input", "-"] : []),
        ],
        undefined,
        body ? JSON.stringify(body) : undefined,
      ),
    );
  const identity = JSON.parse(
    await command(["gh", "api", `repos/${c.repository}`]),
  );
  if (
    identity.id !== c.repositoryId ||
    identity.full_name !== c.repository ||
    !identity.private
  )
    throw new Error("Repository identity or private visibility mismatch");
  if (
    (await git("remote", "get-url", "origin")) !==
    `https://github.com/${c.repository}.git`
  )
    throw new Error("Unexpected git remote");
  if ((await git("branch", "--show-current")) !== c.branch)
    throw new Error("Unexpected local branch");
  const file = resolve(c.directory, "app.mjs");
  const statePath = resolve(c.evidence, "state.json");
  const state: any = (await Bun.file(statePath).exists())
    ? await Bun.file(statePath).json()
    : { checks: [], reviews: [], events: [] };
  const save = () =>
    Bun.write(statePath, JSON.stringify(state, null, 2) + "\n");
  await save();
  const current = async () => digest(await Bun.file(file).text());
  const record = async (action: string, data: any) => {
    state.events.push({ time: new Date().toISOString(), action, ...data });
    await save();
  };
  const skills = await loadSkills(c.skillsRoot);
  const base = createEvalTools(skills, liveCase, ledger);
  const node = c.nodeBinary ?? Bun.which("node");
  if (!node || !/^v24\./.test(await command([node, "--version"])))
    throw new Error("Live executable checks require selected Node 24");
  if (process.platform !== "darwin")
    throw new Error(
      "Live executable checks require macOS sandbox-exec; no unrestricted fallback",
    );
  const runSafe = async (args: string[], input?: string) => {
    const runDirectory = await realpath(
      await mkdtemp("/private/tmp/kgr-live-gate-"),
    );
    await cp(file, resolve(runDirectory, "app.mjs"));
    await cp(
      resolve(c.directory, "test.mjs"),
      resolve(runDirectory, "test.mjs"),
    );
    const sandbox = `(version 1)(allow default)(deny network*)(deny file-write*)(deny file-read-data (subpath ${JSON.stringify(homedir())}))(allow file-read* (subpath ${JSON.stringify(runDirectory)}) (subpath ${JSON.stringify(resolve(node, "../.."))}))`;
    const p = Bun.spawn(
      [
        "/usr/bin/sandbox-exec",
        "-p",
        sandbox,
        node,
        "--permission",
        `--allow-fs-read=${runDirectory}`,
        ...args,
      ],
      {
        cwd: runDirectory,
        env: { PATH: "/usr/bin:/bin", NODE_NO_WARNINGS: "1" },
        stdin: input === undefined ? "ignore" : "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (input !== undefined) {
      (p.stdin as any).write(input);
      (p.stdin as any).end();
    }
    const timeout = setTimeout(() => p.kill("SIGKILL"), 5000);
    try {
      const [out, err, exit] = await Promise.all([
        readProcessText(p.stdout),
        readProcessText(p.stderr),
        p.exited,
      ]);
      return { out, err, exit };
    } finally {
      clearTimeout(timeout);
      await rm(runDirectory, { recursive: true, force: true });
    }
  };
  const check = async () => {
    const revision = await current();
    const gate = await runSafe(["--test", "--test-isolation=none", "test.mjs"]);
    const probes = [];
    for (const value of ["hello", " padded ", "", "\tindent", "雪", "line\n", "\n", "a\nb", null, 42]) {
      const input = JSON.stringify({ line: value });
      const result = await runSafe(["app.mjs"], input);
      const expected =
        typeof value === "string"
          ? { out: value + "\n", err: "", exit: 0 }
          : { out: "", err: "line must be a string\n", exit: 2 };
      probes.push({
        input,
        expected,
        ...result,
        passed: JSON.stringify(result) === JSON.stringify(expected),
      });
    }
    const result = {
      revision,
      passed: gate.exit === 0 && probes.every((p) => p.passed),
      gate,
      probes,
    };
    state.checks.push(result);
    await record("projectGate", result);
    return result;
  };
  const inspect = async () => ({
    repository: c.repository,
    branch: c.branch,
    base: c.base,
    head: await git("rev-parse", "HEAD"),
    status: await git("status", "--short"),
    content: await Bun.file(file).text(),
    diff: await git("diff", c.base, "--", "app.mjs"),
    contract: await Bun.file(resolve(c.directory, "AGENTS.md")).text(),
    tests: await Bun.file(resolve(c.directory, "test.mjs")).text(),
    issue: c.issueUrl ? await api(`issues/${c.issueUrl.split("/").at(-1)}`) : null,
    evidence: state,
  });
  const tools: any = {
    loadSkill: base.loadSkill,
    readSkillReference: base.readSkillReference,
    inspectLiveRepo: {
      description:
        "Read actual repository, app, diff, tests, and current observed gate/review/PR state.",
      inputSchema: z.object({}),
      execute: inspect,
    },
    runProjectGate: {
      description:
        "Execute the declared real Node test gate and real CLI boundary probes; result is bound to application content.",
      inputSchema: z.object({}),
      execute: check,
    },
  };
  tools.researchContract = {
    description:
      "Read the coordinator's current web-search receipt and refresh the matching MDN primary documentation over HTTPS. The search and page evidence are real, not simulated.",
    inputSchema: z.object({}),
    execute: async () => {
      const url =
        "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/trim";
      if (c.research.url !== url) throw new Error("Unexpected source");
      const response = await fetch(url, { redirect: "error" });
      if (!response.ok) throw new Error("Primary documentation unavailable");
      const html = await response.text();
      if (!html.includes("removes whitespace"))
        throw new Error(
          "Primary documentation changed; review source before proceeding",
        );
      const result = {
        ...c.research,
        retrievedAt: new Date().toISOString(),
        httpStatus: response.status,
        pageSha256: digest(html),
        runtime: await command([node, "--version"]),
      };
      await record("research", result);
      return result;
    },
  };
  if (role === "review") {
    tools.submitReview = {
      description:
        "Return the independent review of the actual changed app and tests. No mutation is available.",
      inputSchema: z.object({
        verdict: z.enum(["pass", "fail"]),
        findings: z
          .array(
            z.object({
              severity: z.enum([
                "BLOCKING",
                "IMPORTANT",
                "IMPROVEMENT",
                "NITPICK",
              ]),
              body: z.string().min(1),
              withinScope: z.boolean(),
            }),
          )
          .describe(
            "Actionable defects only; put positive observations and coverage commentary in reason. Empty when no defects.",
          ),
        reason: z.string().min(1),
      }),
      execute: async (result: any) => {
        if (!c.reviewAttempt || c.reviewAttempt.revision !== (await current()))
          throw new Error("Review attempt is missing or its content changed");
        if (state.reviews.some((r: any) => r.attempt === c.reviewAttempt!.id))
          throw new Error("Review attempt already submitted its verdict");
        state.reviews.push({
          ...result,
          attempt: c.reviewAttempt.id,
          revision: c.reviewAttempt.revision,
          model: c.model,
        });
        await record("reviewReturned", state.reviews.at(-1));
        return { recorded: true };
      },
    };
    return tools;
  }
  const requireGate = async () => {
    const revision = await current();
    if (!state.checks.some((x: any) => x.revision === revision && x.passed))
      throw new Error(
        "Current application has no passing observed project gate",
      );
    return revision;
  };
  tools.syncRemoteDefault = {
    description:
      "Verify clean worktree, fetch main and verify it is the confirmed baseline already included in this focused branch. Stop on dirty or changed base.",
    inputSchema: z.object({}),
    execute: async () => {
      if (await git("status", "--porcelain"))
        throw new Error("Dirty worktree; sync must precede edits");
      await git("fetch", "origin", "main");
      const remote = await git("rev-parse", "origin/main");
      if (remote !== c.base) throw new Error("Remote baseline changed");
      await git("merge-base", "--is-ancestor", remote, "HEAD");
      await record("synced", { remote });
      return { remote, clean: true, included: true };
    },
  };
  tools.editApplication = {
    description:
      "Replace exactly one occurrence in app.mjs. No other path is editable; validation and review become stale on content change.",
    inputSchema: z.object({ oldText: z.string().min(1), newText: z.string() }),
    execute: async ({ oldText, newText }: any) => {
      const before = await Bun.file(file).text();
      if (before.split(oldText).length !== 2)
        throw new Error("Expected exactly one match");
      await Bun.write(file, before.replace(oldText, newText));
      await record("edit", { revision: await current() });
      return { revision: await current() };
    },
  };
  tools.reviewChange = {
    description:
      "Run a real independent native review agent on this model against the current repository diff; its separate ledger and result are retained.",
    inputSchema: z.object({}),
    execute: async () => {
      const revision = await requireGate();
      const attempt = randomUUID();
      const transcript = resolve(c.evidence, `review-${attempt}.jsonl`);
      const reviewConfig = resolve(c.evidence, `review-${attempt}-config.json`);
      await Bun.write(
        reviewConfig,
        JSON.stringify({
          ...c,
          reviewAttempt: { id: attempt, revision },
        }),
      );
      const version = await preflight(c.model);
      const task = liveReviewTask(c, attempt, revision, formatSkillCatalog(skills));
      await atomicJson(resolve(c.evidence, `review-${attempt}-task.json`), task);
      const result = await runLocal({
        target: c.model,
        effort: "medium",
        skillsRoot: c.skillsRoot,
        evalCase: {
          ...liveCase,
          prompt: task.prompt,
        },
        instructions: task.instructions,
        transcript,
        server: {
          path: resolve(import.meta.dir, "github-live-server.ts"),
          args: [reviewConfig, "review"],
          approvedTools: [
            "loadSkill",
            "readSkillReference",
            "inspectLiveRepo",
            "runProjectGate",
            "submitReview",
            "researchContract",
          ],
        },
      });
      await atomicJson(resolve(c.evidence, `review-${attempt}-result.json`), result);
      const latest = await Bun.file(statePath).json();
      state.reviews = latest.reviews;
      state.events = latest.events;
      state.checks = latest.checks;
      await record("reviewProcess", {
        attempt,
        revision,
        model: c.model,
        exitCode: result.exitCode,
        completed:
          !result.error &&
          result.exitCode === 0 &&
          !result.cancellationRequested,
        cancellationRequested: result.cancellationRequested,
        error: result.error,
        version,
        transcript,
        loadedSkills: result.ledger.loadedSkills,
        responseModels: result.responseModels,
      });
      if (result.error || !result.ledger.loadedSkills.includes("code-review"))
        throw new Error(
          "Independent review did not complete its code-review contract",
        );
      if ((await current()) !== revision)
        throw new Error("Content changed while the independent review ran");
      const review = state.reviews.find((r: any) => r.attempt === attempt);
      const evidence = await readLiveReviewEvidence(c, state, review);
      return {
        output: result.output,
        review,
        observedModels: result.responseModels,
        evidence,
      };
    },
  };
  tools.publishDraft = {
    description:
      "Commit app.mjs only, push the configured branch, and create a real draft PR. Requires current passing gate and independent review. No merge capability.",
    inputSchema: z.object({
      title: z.string().regex(/^fix(?:\([a-z-]+\))?: /),
      body: z.string().min(1),
    }),
    execute: async ({ title, body }: any) => {
      const revision = await requireGate();
      const review = completedReview(state, revision);
      if (!review)
        throw new Error(
          "Missing passing independent review for current content",
        );
      const reviewEvidence = await readLiveReviewEvidence(c, state, review);
      const changed = (await git("diff", "--name-only", c.base))
        .split("\n")
        .filter(Boolean);
      if (
        changed.some((p) => p !== "app.mjs") ||
        Boolean(await git("ls-files", "--others", "--exclude-standard"))
      )
        throw new Error("Changes escape app.mjs");
      if (await git("status", "--porcelain")) {
        await git("add", "--", "app.mjs");
        await git("commit", "-m", title);
      }
      state.head = await git("rev-parse", "HEAD");
      if (state.head === c.base) throw new Error("No change to publish");
      await git("push", "--set-upstream", "origin", c.branch);
      if (!state.pr) {
        const pr = await api("pulls", {
          title,
          body: c.issueUrl ? `${body}\n\nCloses ${c.issueUrl}` : body,
          head: c.branch,
          base: "main",
          draft: true,
        });
        state.pr = pr.number;
        state.url = pr.html_url;
      }
      await record("draftPublished", {
        revision,
        reviewAttempt: review.attempt,
        reviewEvidence,
        pr: state.pr,
        head: state.head,
        url: state.url,
      });
      return { pr: state.pr, head: state.head, url: state.url, draft: true };
    },
  };
  tools.waitCi = {
    description:
      "Run the bundled deterministic delivery wait on the actual PR and exact head, returning terminal GitHub check evidence.",
    inputSchema: z.object({}),
    execute: async () => {
      if (!state.pr) throw new Error("No PR");
      const deadline = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const p = Bun.spawn(
        [
          "python3",
          resolve(c.skillsRoot, "delivery-wait/scripts/delivery_wait.py"),
          "wait",
          "checks-terminal",
          "--repo",
          c.repository,
          "--pr",
          String(state.pr),
          "--head",
          state.head,
          "--check",
          "project-gate",
          "--deadline",
          deadline,
          "--interval",
          "5",
          "--state",
          resolve(c.evidence, "wait.json"),
          "--json",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [raw, err, code] = await Promise.all([
        readProcessText(p.stdout),
        readProcessText(p.stderr),
        p.exited,
      ]);
      let observed;
      try {
        observed = JSON.parse(raw);
      } catch {
        throw new Error(`Invalid wait result ${code}: ${err.slice(0, 500)}`);
      }
      state.ci = observed;
      await record("ciObserved", { head: state.head, code, observed });
      return observed;
    },
  };
  tools.markReady = {
    description:
      "Mark the actual draft ready only when a fresh GitHub check census passes for the exact published head and local evidence is current. Does not merge.",
    inputSchema: z.object({}),
    execute: async () => {
      const revision = await requireGate();
      const review = completedReview(state, revision);
      if (!review) throw new Error("No passing review for readiness");
      await readLiveReviewEvidence(c, state, review);
      const pr = await api(`pulls/${state.pr}`);
      if (
        pr.head.sha !== state.head ||
        (await git("rev-parse", "HEAD")) !== state.head ||
        (await git("status", "--porcelain"))
      )
        throw new Error("Published head changed or local work is dirty");
      const runs = await api(`commits/${state.head}/check-runs?per_page=100`);
      const gate = runs.check_runs.filter(
        (r: any) => r.name === "project-gate" && r.head_sha === state.head,
      );
      if (
        gate.length !== 1 ||
        gate[0].status !== "completed" ||
        gate[0].conclusion !== "success"
      )
        throw new Error("No unique successful exact-head project-gate");
      await command([
        "gh",
        "pr",
        "ready",
        String(state.pr),
        "--repo",
        c.repository,
      ]);
      state.ready = true;
      await record("ready", { head: state.head, check: gate[0].html_url });
      return {
        url: state.url,
        head: state.head,
        ready: true,
        check: gate[0].html_url,
      };
    },
  };
  return tools;
}
