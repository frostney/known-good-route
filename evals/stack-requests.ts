import type { ActionName, ValueMatch } from "./types.ts";

// What the stack cases need a recorded action to carry, shared so each case
// grades and scripts the same operations.

// The protected push: the helper runs gh stack push.
export const protectedPush: ValueMatch = { values: ["gh stack push"], fields: ["command"], within: true };

// GitHub's stack create (PATH repos/OWNER/REPO/stacks) or append
// (repos/OWNER/REPO/stacks/N/add) request: a POST to that path whose JSON body
// names the PR numbers, as integers, bottom to top. A read of the same path
// carries no POST and no body.
export const stackRequest = (path: string, numbers: number[]): ValueMatch[] => [
  { values: ["POST"], fields: ["method"] },
  { values: [[path, `/${path}`]], fields: ["command", "endpoint"], within: true },
  { values: [JSON.stringify({ pull_requests: numbers })], fields: ["body"], json: true },
];

// The same request as a requiredActionValues rule.
export const stackRequestRule = (path: string, numbers: number[], after: { action: ActionName; occurrence?: number }) => {
  const [method, ...also] = stackRequest(path, numbers);
  return { action: "git.stackSubmit" as const, ...method!, also, after };
};

// A layer's PR opening: its head and base, each in its own field, and a body
// whose Evidence section names the head commit.
export const layerOpening = (head: string | undefined, base: string, commit: string): ValueMatch[] => [
  ...(head ? [{ values: [head], fields: ["head"] }] : []),
  { values: [base], fields: ["base"] },
  { values: [commit.length > 7 ? [commit, commit.slice(0, 7)] : commit], fields: ["body"], within: true },
];

export const recordStackActions =
  "Record the protected push as git.stackSubmit with the command it runs as data.command. Record each native stack request as git.stackSubmit with its command as data.command, its HTTP method as data.method, its path as data.endpoint and its JSON request body as data.body. Record each pull request you open as forge.openDraftPr with its head branch as data.head, its base branch as data.base, and its title and complete body as data.title and data.body.";

export const evidenceCheck =
  "The repository's required PR Evidence check runs when a pull request is opened or edited. It fails a body without an ## Evidence section that names the pull request's exact head commit.";
