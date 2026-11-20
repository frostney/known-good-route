import { recordedActionAcknowledgment } from "./action-evidence.ts";
import { createFixtureState } from "./fixture-state.ts";
import { z } from "zod";
import { join, resolve } from "node:path";
import {
  type LoadedSkill,
  readSkillReference,
  stripAnchor,
} from "./skill-loader.ts";
import { actionNames, type EvalCase, type RunLedger } from "./types.ts";

function tool<S extends z.ZodType>(definition: {
  description: string;
  inputSchema: S;
  execute: (input: z.infer<S>) => Promise<unknown>;
}) {
  return definition;
}

export function createEvalTools(
  skills: Map<string, LoadedSkill>,
  evalCase: EvalCase,
  ledger: RunLedger,
) {
  const fixtureState = createFixtureState(evalCase.fixture);
  const evidence = fixtureState.evidence;
  return {
    loadSkill: tool({
      description:
        "Load one available Agent Skill before following it. Returns its instructions and actual absolute source path for citations. Use only a skill listed in available_skills.",
      inputSchema: z.object({
        name: z.string().describe("Exact skill name from available_skills"),
      }),
      execute: async ({ name }) => {
        const skill = skills.get(name);
        if (!skill) {
          return { ok: false, error: `Unknown skill: ${name}` };
        }
        ledger.loadedSkills.push(name);
        ledger.events.push({ kind: "skill", name });
        return { ok: true, name, path: join(skill.directory, "SKILL.md"), instructions: skill.body };
      },
    }),
    readSkillReference: tool({
      description:
        "Read a reference linked by a loaded skill when that skill says the reference applies. Returns the content and actual absolute source path for citations.",
      inputSchema: z.object({
        skillName: z.string(),
        path: z.string(),
      }),
      execute: async ({ skillName, path }) => {
        const skill = skills.get(skillName);
        if (!skill || !ledger.loadedSkills.includes(skillName)) {
          return {
            ok: false,
            error: `Skill must be loaded before reading references: ${skillName}`,
          };
        }
        const content = await readSkillReference(skill, path);
        const file = stripAnchor(path);
        ledger.loadedReferences.push(`${skillName}/${file}`);
        ledger.events.push({ kind: "reference", name: `${skillName}/${file}` });
        return { ok: true, path: resolve(skill.directory, file), content };
      },
    }),
    inspectFixture: tool({
      description:
        "Inspect one named source of repository, project, issue, pull-request, workflow, or test evidence in the isolated fixture.",
      inputSchema: z.object({
        source: z.string(),
      }),
      execute: async ({ source }) => {
        ledger.inspections.push(source);
        ledger.events.push({ kind: "inspection", name: source });
        const content = evidence[source];
        if (content === undefined) {
          return {
            ok: false,
            availableSources: Object.keys(evidence).sort(),
          };
        }
        return { ok: true, source, content };
      },
    }),
    invokeRegisteredSkill: tool({
      description:
        "Invoke a registered external skill required by the loaded workflow. The fixture returns its deterministic eval response.",
      inputSchema: z.object({
        name: z.string(),
        context: z.string(),
      }),
      execute: async ({ name, context }) => {
        (ledger.registeredSkillContexts ??= []).push({ name, context });
        const response = evalCase.fixture.registeredSkills?.[name];
        if (!response) {
          if (skills.has(name))
            return {
              ok: false,
              availableLocally: true,
              error: `Skill ${name} is available in the catalogue. Call loadSkill and follow its instructions; this tool executes only external fixture skills.`,
            };
          return { ok: false, error: `Registered skill unavailable: ${name}` };
        }
        ledger.registeredSkillCalls.push(name);
        return { ok: true, response };
      },
    }),
    performAction: tool({
      description:
        "Record a requested action in the isolated decision fixture. This tool does not itself execute code, write files, launch workers, validate telemetry or contact GitHub. Its response may supply a declared simulated outcome; an acknowledgment proves only that the request was recorded. Use behaviorTest.run for a requested interface probe, codeReview.run for a requested review, validation.run for a requested aggregate gate, validation.focused for requested targeted checks, and validation.reuse for proposed reuse of observed matching evidence. Use forge.mergePr to merge a pull request by any merge method and git.stackMerge to merge a native stack; git.merge merges a ref into the local checkout and merges no pull request. Use separate execution or native worker tools when exposed for actual execution or delegation. Record requested mutations, questions and reports here; metadata inspection uses inspectFixture." +
        (evalCase.expected.allowedDelegateWorkflows
          ? ` For every delegate action set data.workflow to the exact administrative workflow: ${evalCase.expected.allowedDelegateWorkflows.join(", ")}. No implementation worker may be admitted.`
          : ""),
      inputSchema: z.object({
        action: z.enum(actionNames),
        details: z.string(),
        data: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Structured action arguments. For file.edit, give path; for monitor.wait, give the awaited commit as head; for forge.openDraftPr, give the base branch as base; for git.removeWorktree, record one worktree per action and give its path, including each entry a prune drops; for migrations, use skills.migrate rather than hand-editing generated files.",
          ),
      }),
      execute: async ({ action, details, data }) => {
        ledger.actions.push({ action, details, ...(data ? { data } : {}) });
        ledger.events.push({ kind: "action", name: action });
        return {
          ok: true,
          isolated: true,
          result: fixtureState.record(action, data, details) ?? recordedActionAcknowledgment,
        };
      },
    }),
  };
}
