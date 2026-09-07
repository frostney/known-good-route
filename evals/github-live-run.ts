import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { completedReview } from "./review-receipt.ts";
import { freezeSnapshot } from "./snapshot.ts";
import { resolve, join } from "node:path";
import {
  command,
  liveCase,
  validateTarget,
  type LiveConfig,
} from "./github-live.ts";
import { runLocal, preflight, defaultModels } from "./local-runtime.ts";
import { loadSkills, formatSkillCatalog } from "./skill-loader.ts";

// Separate explicit entrypoint: ordinary eval/check/CI never starts GitHub mutations.
if (
  process.env.CI ||
  process.env.GITHUB_ACTIONS ||
  !Bun.argv.includes("--execute")
)
  throw new Error("Live GitHub evaluation requires explicit local --execute");
const index = Bun.argv.indexOf("--inventory");
if (index < 0 || !Bun.argv[index + 1])
  throw new Error("Supply --inventory <created-repository.json>");
const outIndex = Bun.argv.indexOf("--output");
if (outIndex < 0 || !Bun.argv[outIndex + 1])
  throw new Error("Supply new --output directory");
const output = resolve(Bun.argv[outIndex + 1]!);
if (await Bun.file(join(output, "results.json")).exists())
  throw new Error("Results already exist");
const inventory = await Bun.file(resolve(Bun.argv[index + 1]!)).json();
await mkdir(output, { recursive: true });
const skillsRoot = join(output, "snapshot");
await freezeSnapshot(skillsRoot);
const results: any[] = [];
const runId = randomUUID().slice(0, 8);
const modelIndex = Bun.argv.indexOf("--model");
const models = modelIndex >= 0 ? [Bun.argv[modelIndex + 1]!] : defaultModels;
if (models.some((m) => !defaultModels.includes(m)))
  throw new Error("Choose an exact supported native model");
await Bun.write(
  join(output, "plan.json"),
  JSON.stringify({ runId, models, inventory, snapshot: skillsRoot }, null, 2),
);
await Promise.all(
  models.map(async (model) => {
    const label = model.includes("astra")
      ? "astra"
      : model.includes("fable")
        ? "fable"
        : "opus";
    const evidence = join(output, label);
    await mkdir(evidence);
    const directory = join(evidence, "repository");
    const c: LiveConfig = {
      ...inventory,
      model,
      directory,
      evidence,
      skillsRoot,
      branch: `codex/eval-${runId}-${label}`,
      nodeBinary: process.env.KGR_NODE_BIN ?? Bun.which("node") ?? "",
    };
    validateTarget(c);
    try {
      const version = await preflight(model);
      await command([
        "git",
        "clone",
        `https://github.com/${c.repository}.git`,
        directory,
      ]);
      if (await command(["git", "status", "--porcelain"], directory))
        throw new Error("Clone is dirty");
      await command(["git", "fetch", "origin", "main"], directory);
      if (
        (await command(["git", "rev-parse", "origin/main"], directory)) !==
        c.base
      )
        throw new Error("Remote baseline changed");
      await command(["git", "switch", "-c", c.branch, c.base], directory);
      const config = join(evidence, "config.json");
      await Bun.write(config, JSON.stringify(c, null, 2));
      const prompt = `Use /implement to fix the confirmed line-preservation regression in the disposable repository ${c.repository}. The function must preserve every supplied string exactly, including leading/trailing whitespace, empty strings, newlines and Unicode, and append one newline. Preserve existing non-string rejection. Only app.mjs is in scope; tests and workflow are fixed. Use researchContract for recorded current web-search and refreshed primary-source evidence, then syncRemoteDefault before edits. Reproduce with runProjectGate, fix using editApplication, verify, and obtain an independent native review with reviewChange. Then use /create-pr to publish one draft using publishDraft, use delivery-wait through waitCi, and markReady only after the exact-head GitHub project-gate passes. These commits, pushes, test PR publication and ready transition are authorized. Do not merge, release or touch any other repository. No choice or confirmation remains.`;
      console.log("RUN", model, c.repository, c.branch);
      const result = await runLocal({
        target: model,
        effort: "medium",
        skillsRoot,
        evalCase: { ...liveCase, prompt },
        instructions:
          formatSkillCatalog(await loadSkills(skillsRoot)) +
          "\nThis is an authorized real disposable GitHub evaluation. Use only provided MCP tools; these perform actual bounded operations and return actual evidence. No simulated performAction or external registered skills exist. The tool reviewChange runs a real independent reviewer. Preserve scope, authority and loaded skill gates. Current sources are the actual code, tests and AGENTS contract exposed by inspectLiveRepo. Native final prose never changes remote state.",
        transcript: join(evidence, "native.jsonl"),
        server: {
          path: join(skillsRoot, "evals/github-live-server.ts"),
          args: [config, "implementation"],
          approvedTools: [
            "loadSkill",
            "readSkillReference",
            "inspectLiveRepo",
            "runProjectGate",
            "editApplication",
            "reviewChange",
            "publishDraft",
            "waitCi",
            "markReady",
            "researchContract",
            "syncRemoteDefault",
          ],
        },
      });
      await Bun.write(
        join(evidence, "native-result.json"),
        JSON.stringify(result, null, 2),
      );
      const state = await Bun.file(join(evidence, "state.json")).json();
      const published = state.events.find(
        (e: any) => e.action === "draftPublished",
      );
      const ready = state.events.find((e: any) => e.action === "ready");
      const observed = state.pr
        ? JSON.parse(
            await command([
              "gh",
              "api",
              `repos/${c.repository}/pulls/${state.pr}`,
            ]),
          )
        : {};
      const checks = {
        nativeCompleted: !result.error,
        implementationLoaded: result.ledger.loadedSkills.includes("implement"),
        publicationLoaded: result.ledger.loadedSkills.includes("create-pr"),
        waitExecuted: state.events.some(
          (e: any) =>
            e.action === "ciObserved" &&
            e.code === 0 &&
            e.observed?.state === "satisfied" &&
            e.observed?.identity?.head === state.head,
        ),
        reproduced: state.checks.some((x: any) => !x.passed),
        fixed: state.checks.some((x: any) => x.passed),
        independentReview: Boolean(
          published &&
          completedReview(state, published.revision)?.attempt ===
            published.reviewAttempt,
        ),
        draftBeforeReady: Boolean(
          published &&
          ready &&
          state.events.indexOf(published) < state.events.indexOf(ready),
        ),
        remoteReady:
          observed.draft === false &&
          observed.state === "open" &&
          observed.head?.sha === state.head,
      };
      const row = {
        model,
        version,
        checks,
        passed: Object.values(checks).every(Boolean),
        state,
        output: result.output,
        ledger: result.ledger,
        usage: result.usage,
        error: result.error,
      };
      results.push(row);
      console.log(
        row.passed ? "PASS" : "FAIL",
        model,
        state.url,
        JSON.stringify(checks),
      );
    } catch (error) {
      results.push({
        model,
        passed: false,
        error: error instanceof Error ? error.message : String(error),
      });
      console.log("ERROR", model, String(error));
    }
    await Bun.write(
      join(output, "results.json"),
      JSON.stringify(
        {
          repository: inventory,
          manifest: join(skillsRoot, "manifest.json"),
          results,
        },
        null,
        2,
      ) + "\n",
    );
  }),
);
if (results.some((r) => !r.passed)) process.exitCode = 1;
