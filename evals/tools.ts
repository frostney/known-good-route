import { tool } from "ai";
import { z } from "zod";
import {
  type LoadedSkill,
  readSkillReference,
} from "./skill-loader.ts";
import {
  actionNames,
  type EvalCase,
  type RunLedger,
} from "./types.ts";

export function createEvalTools(
  skills: Map<string, LoadedSkill>,
  evalCase: EvalCase,
  ledger: RunLedger,
) {
  return {
    loadSkill: tool({
      description:
        "Load one available Agent Skill before following it. Use only a skill listed in available_skills.",
      inputSchema: z.object({
        name: z.string().describe("Exact skill name from available_skills"),
      }),
      execute: async ({ name }) => {
        const skill = skills.get(name);
        if (!skill) {
          return { ok: false, error: `Unknown skill: ${name}` };
        }
        ledger.loadedSkills.push(name);
        return { ok: true, name, instructions: skill.body };
      },
    }),
    readSkillReference: tool({
      description:
        "Read a reference linked by a loaded skill when that skill says the reference applies.",
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
        ledger.loadedReferences.push(`${skillName}/${path}`);
        return { ok: true, content };
      },
    }),
    inspectFixture: tool({
      description:
        "Inspect one named source of repository, project, issue, workflow, test, or forge evidence in the isolated fixture.",
      inputSchema: z.object({
        source: z.string(),
      }),
      execute: async ({ source }) => {
        ledger.inspections.push(source);
        const content = evalCase.fixture.evidence[source];
        if (content === undefined) {
          return {
            ok: false,
            availableSources: Object.keys(evalCase.fixture.evidence).sort(),
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
      execute: async ({ name }) => {
        const response = evalCase.fixture.registeredSkills?.[name];
        if (!response) {
          return { ok: false, error: `Registered skill unavailable: ${name}` };
        }
        ledger.registeredSkillCalls.push(name);
        return { ok: true, response };
      },
    }),
    performAction: tool({
      description:
        "Record an action in the isolated fixture. Every mutation, validation, user question, delegation, or external action must use this tool; it never changes a real repository or forge.",
      inputSchema: z.object({
        action: z.enum(actionNames),
        details: z.string(),
      }),
      execute: async ({ action, details }) => {
        ledger.actions.push({ action, details });
        return {
          ok: true,
          isolated: true,
          result:
            evalCase.fixture.actionResponses?.[action] ??
            "Action recorded; no real external side effect occurred.",
        };
      },
    }),
  };
}
