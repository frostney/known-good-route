import type { EvalCase } from "./types.ts";
const common = {
  repositoryStatus:
    "Disposable local fixture, clean focused branch, remote default already fetched and included. No unrelated changes. Only app.mjs is editable. Do not commit, push, or publish.",
  projectDefinitions:
    "The selected scope and approach are approved. Ready: reproduce the CLI defect; Done: the actual executable passes cli-regressions on its final content. This tiny fixture has no additional aggregate gate or publication requirement.",
  currentWebResearch:
    "The installed Node 24.18 runtime was verified with executable stdin/stdout probes. MDN nullish-coalescing documentation confirms that the operator preserves false, zero and empty strings. This evidence is supplied for the isolated fixture.",
  executionSurface:
    "Use inspectExecution, editExecutionFile and runExecutionCheck for actual code and verification. performAction only records workflow decisions; it cannot edit or test the real app. The bounded regression oracle runs the app through stdin/stdout and compares observed output and exit status.",
};
export const executionCases: EvalCase[] = [
  {
    id: "execution-cache-cli",
    execution: "cache-cli",
    description:
      "A native model fixes a real disposable CLI; falsey values survive and null/missing use the fallback.",
    prompt:
      "/implement the selected cache fix in the disposable CLI. Preserve every supplied non-null value including empty string, false and zero; only null or absent value maps to 'missing'. Use the existing expression seam, reproduce with the actual CLI check, then fix and verify. Keep this local; no commit or publication. Use the actual execution tools, not simulated edit/test receipts.",
    fixture: {
      evidence: {
        ...common,
        context:
          "The user selected a nullish fallback at the existing expression; no comparison or interview remains.",
      },
    },
    expected: {
      requiredSkills: ["implement"],
      requiredActions: ["file.edit"],
      forbiddenActions: [
        "user.ask",
        "git.commit",
        "git.push",
        "forge.openDraftPr",
      ],
      allowedEditPaths: ["app.mjs"],
    },
  },
  {
    id: "execution-authorization-cli",
    execution: "authorization-cli",
    description:
      "A real executable enforces the 100-item limit while preserving authorization precedence.",
    prompt:
      "/implement the agreed one-line boundary correction in the disposable CLI: authenticated requests accept counts 0 through 100 and reject counts above 100 with error 'limit'. Every unauthenticated request must still return error 'unauthorized', regardless of count. Reproduce, fix and verify with the actual execution tools. No redesign, commit or publication.",
    fixture: {
      evidence: {
        ...common,
        context:
          "Existing auth-before-validation order is a settled contract. The approved correction is the item-limit comparison; preserve authorization precedence.",
      },
    },
    expected: {
      requiredSkills: ["implement"],
      requiredActions: ["file.edit"],
      forbiddenActions: [
        "user.ask",
        "git.commit",
        "git.push",
        "forge.openDraftPr",
      ],
      allowedEditPaths: ["app.mjs"],
    },
  },
];
