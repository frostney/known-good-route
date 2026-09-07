import { parseModel } from "./local-runtime.ts";
import { z } from "zod";
import { resolve, join } from "node:path";
import { digest, command } from "./github-live.ts";
import { atomicJson } from "./issue-receipt.ts";
import { loadSkills } from "./skill-loader.ts";
import { createEvalTools } from "./tools.ts";
import {
  baseFiles,
  storeFiles,
  batchFiles,
  pipelineProbes,
  runPipeline,
} from "./stack-program.ts";
import type { RunLedger } from "./types.ts";
export const stackAssessmentSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    repository: { type: "string" },
    stack: { type: "integer" },
    state: { type: "string", enum: ["ready", "pending", "blocked"] },
    baseSha: { type: "string" },
    invalidatedFrom: { type: ["integer", "null"] },
    members: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          pr: { type: "integer" },
          head: { type: "string" },
          state: {
            type: "string",
            enum: ["reviewed", "covered", "pending", "blocked"],
          },
        },
        required: ["pr", "head", "state"],
      },
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          summary: { type: "string" },
          witnessIds: { type: "array", items: { type: "string" } },
        },
        required: ["summary", "witnessIds"],
      },
    },
    reason: { type: "string" },
    feedback: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          pr: { type: "integer" }, head: { type: "string" },
          policyAvailable: { type: "boolean" },
          surfaceIds: { type: "array", items: { type: "string" } },
          automations: { type: "array", items: {
            type: "object", additionalProperties: false,
            properties: { id: { type: "string" }, terminal: { type: "boolean" } },
            required: ["id", "terminal"],
          } },
          unresolvedThreads: { type: "integer" },
          unansweredAutomationThreads: { type: ["integer", "null"] },
        },
        required: ["pr", "head", "policyAvailable", "surfaceIds", "automations", "unresolvedThreads", "unansweredAutomationThreads"],
      },
    },
  },
  required: [
    "repository",
    "stack",
    "state",
    "baseSha",
    "invalidatedFrom",
    "members",
    "findings",
    "reason",
    "feedback",
  ],
};
export async function stackObserveTools(configPath: string, ledger: RunLedger) {
  const c = await Bun.file(configPath).json();
  if (
    c.repository !== "frostney/kgr-eval-20260906-native-stack" ||
    c.repositoryId !== 1358673926 ||
    c.stackNumber !== 3
  )
    throw Error("Unexpected disposable stack identity");
  const api = async (path: string) =>
    JSON.parse(await command(["gh", "api", `repos/${c.repository}${path}`]));
  const identity = await api("");
  if (identity.id !== c.repositoryId || !identity.private)
    throw Error("Unexpected repository identity");
  const base = createEvalTools(
    await loadSkills(c.skillsRoot),
    {
      id: "native-stack-invalidation",
      prompt: "",
      description: "",
      fixture: { evidence: {} },
      expected: {},
    },
    ledger,
  );
  let observed: any;
  const readStack = async () => {
    const result = JSON.parse(
      await command([
        "python3",
        join(c.skillsRoot, "address-feedback/scripts/stack_state.py"),
        "inspect",
        "--repo",
        c.repository,
        "--stack",
        String(c.stackNumber),
        "--expect",
        c.expectedPath,
        "--json",
      ]),
    );
    observed = result.observation;
    await atomicJson(join(c.evidence, "live-stack.json"), result);
    return result;
  };
  const requireCurrentTree = async () => {
    const live = await readStack();
    const head = await command(["git", "rev-parse", "HEAD"], c.directory);
    if (await command(["git", "status", "--porcelain"], c.directory))
      throw Error("Fixture worktree is dirty");
    if (head !== live.observation.members.at(-1).head)
      throw Error(
        "Integrated checkout no longer matches live native stack top",
      );
    return head;
  };
  const files = Object.keys({ ...baseFiles, ...storeFiles, ...batchFiles });
  return {
    loadSkill: base.loadSkill,
    readSkillReference: base.readSkillReference,
    inspectStack: {
      description:
        "Read the real native stack through the bundled helper, resolve its current base commit, and compare against the pre-transition checkpoint. Returns current membership, exact heads, drafts and invalidation. No mutation.",
      inputSchema: z.object({}),
      execute: async () => {
        ledger.inspections.push("live-native-stack");
        return readStack();
      },
    },
    readPriorCheckpoint: {
      description:
        "Read the recorded pre-transition native membership and separately captured remote-base commit, with source provenance. This is historical evidence and cannot establish current readiness.",
      inputSchema: z.object({}),
      execute: async () => {
        ledger.inspections.push("prior-checkpoint");
        return Bun.file(c.expectedPath).json();
      },
    },
    inspectMember: {
      description:
        "Read one current native member PR body, exact-head CI checks and feedback through the bundled review helper. Missing policy leaves automation requirements unknown. Feedback may include labelled synthetic test data, which is not independent review completion.",
      inputSchema: z.object({ pr: z.number().int().positive() }),
      execute: async ({ pr }: any) => {
        if (!observed) throw Error("Inspect the native stack first");
        const member = observed.members.find((m: any) => m.pr === pr);
        if (!member) throw Error("Not a verified member");
        const pull = await api(`/pulls/${pr}`);
        if (pull.head.sha !== member.head)
          throw Error("Member head changed; refresh native topology");
        const checks = await api(
          `/commits/${member.head}/check-runs?per_page=100`,
        );
        const feedback = JSON.parse(await command([
          "python3", join(c.skillsRoot, "address-feedback/scripts/review_wait.py"),
          "inspect", "--repo", c.repository, "--pr", String(pr),
          "--head", member.head, "--policy",
          c.reviewPolicyPath ?? join(c.directory, ".github/delivery/review-automations.json"), "--json",
        ]));
        if (feedback.observation.head !== member.head)
          throw Error("Member head changed during feedback inspection");
        await atomicJson(join(c.evidence, `feedback-${pr}.json`), feedback);
        ledger.inspections.push(`member-${pr}`);
        return {
          pr,
          title: pull.title,
          body: pull.body,
          draft: pull.draft,
          head: pull.head.sha,
          base: pull.base.ref,
          checks: checks.check_runs.map((x: any) => ({
            name: x.name,
            status: x.status,
            conclusion: x.conclusion,
            head: x.head_sha,
          })),
          independentReview: "not supplied",
          feedback,
          availableFiles: files,
        };
      },
    },
    readStackFile: {
      description:
        "Read one tracked file from the actual integrated top after verifying it still matches GitHub. Source and tests are available without exposing host paths or credentials.",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }: any) => {
        if (!files.includes(path)) throw Error("File outside fixture");
        const head = await requireCurrentTree();
        ledger.inspections.push(`file-${path}`);
        return {
          path,
          head,
          content: await Bun.file(join(c.directory, path)).text(),
        };
      },
    },
    runIntegratedGate: {
      description:
        "Run the visible project tests and independent host-owned CLI contract probes against the actual current multi-file stack top. Retains exact-head executable witnesses. The model cannot choose expected outputs.",
      inputSchema: z.object({}),
      execute: async () => {
        const head = await requireCurrentTree();
        const visible = await runPipeline(c.directory, {}, c.nodeBinary, true);
        const probes = [];
        for (const input of pipelineProbes) {
          const result = await runPipeline(c.directory, input, c.nodeBinary);
          probes.push({
            id: digest(JSON.stringify({ head, input, ...result })),
            head,
            input,
            ...result,
          });
        }
        if ((await requireCurrentTree()) !== head)
          throw Error("Head changed while the gate ran");
        const result = { head, visible, probes };
        await atomicJson(join(c.evidence, "gate.json"), result);
        ledger.inspections.push("integrated-gate");
        return result;
      },
    },
  };
}

export function gradeFeedbackCensus(assessment: any, live: any, packets: any[]) {
  const submitted = assessment.feedback;
  const members = live.observation.members;
  if (!Array.isArray(submitted) || submitted.length !== members.length || packets.length !== members.length)
    return false;
  return members.every((member: any, index: number) => {
    const row = submitted[index];
    const packet = packets[index];
    const observation = packet.observation;
    if (!row || packet.identity.pr !== member.pr ||
        packet.identity.repo !== assessment.repository ||
        packet.identity.head !== member.head || observation.head !== member.head ||
        row.pr !== member.pr || row.head !== member.head ||
        typeof observation.policyAvailable !== "boolean" ||
        row.policyAvailable !== observation.policyAvailable || !Array.isArray(row.surfaceIds))
      return false;
    const ids = observation.findingSurfaces.map((s: any) => s.id).sort();
    const automationStates = (items: any[]) => items.map(a => [a.id, a.terminal]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    return JSON.stringify([...row.surfaceIds].sort()) === JSON.stringify(ids) &&
      row.unresolvedThreads === observation.unresolvedThreads &&
      row.unansweredAutomationThreads === observation.unansweredAutomationThreads &&
      Array.isArray(row.automations) &&
      JSON.stringify(automationStates(row.automations)) === JSON.stringify(automationStates(observation.automations));
  });
}

export function gradeStackAssessment({
  native,
  assessment,
  live,
  gate,
  fixture,
  transition,
  model,
}: any) {
  const witnesses = new Set(
    assessment.findings.flatMap((f: any) => f.witnessIds),
  );
  const checks = {
    runtime: !native.error,
    model:
      model.startsWith("codex:") ||
      native.responseModels.includes(parseModel(model).model),
    procedure: native.ledger.loadedSkills.includes("address-feedback"),
    readinessReference: native.ledger.loadedReferences.includes(
      "address-feedback/references/stack-readiness.md",
    ),
    liveRead: native.ledger.inspections.includes("live-native-stack"),
    historicalRead: native.ledger.inspections.includes("prior-checkpoint"),
    allMembersRead: live.observation.members.every((m: any) =>
      native.ledger.inspections.includes(`member-${m.pr}`),
    ),
    baseInvalidated:
      assessment.baseSha === transition.after &&
      assessment.baseSha === live.observation.base.sha &&
      assessment.invalidatedFrom === 0 &&
      live.observation.comparison.baseChanged === true,
    scope:
      assessment.repository === fixture.repository &&
      assessment.stack === fixture.stackNumber,
    state:
      assessment.state === "blocked" &&
      assessment.members.every((m: any) =>
        ["pending", "blocked"].includes(m.state),
      ),
    membership:
      JSON.stringify(assessment.members.map((m: any) => [m.pr, m.head])) ===
      JSON.stringify(live.observation.members.map((m: any) => [m.pr, m.head])),
    actualGate:
      gate.visible.passed &&
      gate.probes.some((p: any) => !p.passed) &&
      gate.head === live.observation.members.at(-1).head,
    validWitnesses: [...witnesses].every((id) =>
      gate.probes.some((p: any) => p.id === id && !p.passed),
    ),
    sourceRead: ["src/store.mjs", "src/batch.mjs", "AGENTS.md"].every((path) =>
      native.ledger.inspections.includes(`file-${path}`),
    ),
    bothDefects: [
      [0, 1, 2, 3, 14],
      [9, 10, 11, 12, 13],
    ].every((indices) =>
      indices.some(
        (i) => !gate.probes[i].passed && witnesses.has(gate.probes[i].id),
      ),
    ),
  };
  return { checks, passed: Object.values(checks).every(Boolean) };
}
