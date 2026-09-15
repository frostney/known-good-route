import { mkdtemp, cp, rm, realpath, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readProcessText } from "./process-output.ts";

export const stackContract = `This disposable evaluation implements a JSON record store and atomic batches.
Every string key is valid, including empty, whitespace, Unicode and __proto__. Keys are preserved exactly.
Every JSON value is valid, including null, false, zero and empty strings. Missing keys return {found:false}; present keys return {found:true,value}.
Store set/get must copy object values so caller mutation cannot alter stored state.
Each batch is an array of operations {op:'set',key:string,value:JSON} or {op:'get',key:string}.
Every operation must be validated before any operation in the batch changes the store. Invalid batches return {ok:false,error:'invalid operation'} and leave the store unchanged. Earlier successful batches remain committed.
A successful batch returns {ok:true,results:[...]}; set yields {stored:true}, get yields the lookup result.
The CLI accepts one JSON object {batches:array,queries:array-of-strings} on stdin. It executes batches in order in one new store, then returns {batches:[batch results],queries:[lookup results]} plus a newline with exit0 and empty stderr.
Invalid JSON or a malformed outer request returns {error:'invalid request'} plus newline, exit2, empty stderr. Nested invalid operations are batch errors, not outer request errors.
Source code is in src/. Tests, workflow and this contract are fixed fixtures. Required CI is project-gate on each exact PR head. Initial layers may contain defects despite passing the visible tests. Validate findings against the integrated top and fix only in new top layers. The complete stack ships atomically; no partial-prefix readiness or merge is authorized.
`;
export const baseFiles: Record<string, string> = {
  "AGENTS.md": "# Disposable stack evaluation\n\n" + stackContract,
  "CLAUDE.md": "@AGENTS.md\n",
  "README.md": "# Atomic record pipeline\n\n" + stackContract,
  "package.json":
    JSON.stringify(
      {
        name: "kgr-disposable-record-pipeline",
        private: true,
        type: "module",
        scripts: { test: "node --test tests/*.test.mjs" },
      },
      null,
      2,
    ) + "\n",
  "tests/environment.test.mjs": `import {test} from 'node:test';\nimport assert from 'node:assert/strict';\ntest('Node 24 runtime',()=>assert.equal(process.versions.node.split('.')[0],'24'));\n`,
  ".github/workflows/gate.yml": `name: Record pipeline gate
on: [push, pull_request]
permissions:
  contents: read
jobs:
  project-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
        with:
          node-version: '24'
      - run: npm test
`,
};
export const storeFiles: Record<string, string> = {
  "src/store.mjs": `export class Store {
  #values = new Map();
  set(key, value) { this.#values.set(key, structuredClone(value)); return {stored:true}; }
  get(key) {
    const value = this.#values.get(key);
    return value ? {found:true,value:structuredClone(value)} : {found:false};
  }
}
`,
  "tests/store.test.mjs": `import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
for (const key of ['alpha','',' padded ','雪','__proto__']) test('exact key '+key,()=>{ const s=new Store(); s.set(key,'value'); assert.deepEqual(s.get(key),{found:true,value:'value'}); assert.deepEqual(s.get(key+'!'),{found:false}); });
test('copies on set and get',()=>{const s=new Store(); const v={nested:[1]}; s.set('k',v); v.nested.push(2); const a=s.get('k'); a.value.nested.push(3); assert.deepEqual(s.get('k'),{found:true,value:{nested:[1]}});});
test('replacement and missing key',()=>{const s=new Store(); assert.deepEqual(s.get('k'),{found:false}); s.set('k',1);s.set('k',2);assert.deepEqual(s.get('k'),{found:true,value:2});});
`,
};
export const batchFiles: Record<string, string> = {
  "src/validate.mjs": `export function validateOperation(op) {
  if (!op || typeof op !== 'object' || Array.isArray(op) || typeof op.key !== 'string' ||
    !['get','set'].includes(op.op) || (op.op === 'set' && !Object.hasOwn(op,'value'))) throw new Error('invalid operation');
}
export function validRequest(input) {
  return input && typeof input === 'object' && !Array.isArray(input) && Array.isArray(input.batches) &&
    Array.isArray(input.queries) && input.queries.every(k=>typeof k === 'string');
}
`,
  "src/batch.mjs": `import {validateOperation} from './validate.mjs';
export function executeBatch(store, operations) {
  if (!Array.isArray(operations)) return {ok:false,error:'invalid operation'};
  const results=[];
  try {
    for (const op of operations) {
      validateOperation(op);
      results.push(op.op === 'set' ? store.set(op.key,op.value) : store.get(op.key));
    }
    return {ok:true,results};
  } catch { return {ok:false,error:'invalid operation'}; }
}
`,
  "src/cli.mjs": `import {Store} from './store.mjs';
import {executeBatch} from './batch.mjs';
import {validRequest} from './validate.mjs';
process.stdin.setEncoding('utf8');
let text=''; for await (const chunk of process.stdin) text+=chunk;
try {
  const input=JSON.parse(text);
  if (!validRequest(input)) throw new Error('invalid request');
  const store=new Store();
  const batches=input.batches.map(ops=>executeBatch(store,ops));
  const queries=input.queries.map(key=>store.get(key));
  process.stdout.write(JSON.stringify({batches,queries})+'\\n');
} catch { process.stdout.write(JSON.stringify({error:'invalid request'})+'\\n');process.exitCode=2; }
`,
  "tests/batch.test.mjs": `import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {executeBatch} from '../src/batch.mjs';
test('ordered writes and reads',()=>{const s=new Store();assert.deepEqual(executeBatch(s,[{op:'set',key:'x',value:2},{op:'get',key:'x'}]),{ok:true,results:[{stored:true},{found:true,value:2}]});});
test('empty batch',()=>assert.deepEqual(executeBatch(new Store(),[]),{ok:true,results:[]}));
for (const ops of [null,{},[null],[{op:'delete',key:'x'}],[{op:'set',key:'x'}],[{op:'get',key:1}]]) test('reject invalid batch '+JSON.stringify(ops),()=>{const s=new Store();assert.deepEqual(executeBatch(s,ops),{ok:false,error:'invalid operation'});assert.deepEqual(s.get('x'),{found:false});});
`,
};

// Independently implement the public contract. No candidate code/imports or
// candidate-supplied expected output participates in this oracle.
export function expectedPipeline(input: any) {
  const response = (output: unknown, exitCode = 0) => ({ output, exitCode });
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    !Array.isArray(input.batches) ||
    !Array.isArray(input.queries) ||
    !input.queries.every((k: any) => typeof k === "string")
  )
    return response({ error: "invalid request" }, 2);
  let entries: Array<[string, unknown]> = [];
  const lookup = (key: string, values = entries) => {
    const entry = values.find((e) => e[0] === key);
    return entry
      ? { found: true, value: structuredClone(entry[1]) }
      : { found: false };
  };
  const batches = input.batches.map((ops: any) => {
    if (
      !Array.isArray(ops) ||
      ops.some(
        (op) =>
          !op ||
          typeof op !== "object" ||
          Array.isArray(op) ||
          typeof op.key !== "string" ||
          (op.op !== "get" && op.op !== "set") ||
          (op.op === "set" && !Object.hasOwn(op, "value")),
      )
    )
      return { ok: false, error: "invalid operation" };
    const staged = structuredClone(entries);
    const results = ops.map((op) => {
      if (op.op === "get") return lookup(op.key, staged);
      const index = staged.findIndex((e) => e[0] === op.key);
      const entry: [string, unknown] = [op.key, structuredClone(op.value)];
      if (index < 0) staged.push(entry);
      else staged[index] = entry;
      return { stored: true };
    });
    entries = staged;
    return { ok: true, results };
  });
  return response({
    batches,
    queries: input.queries.map((k: string) => lookup(k)),
  });
}
export const pipelineProbes = [
  ...[null, false, 0, "", 1, "value", [], {}, ["雪"]].map((value) => ({
    batches: [
      [
        { op: "set", key: "k", value },
        { op: "get", key: "k" },
      ],
    ],
    queries: ["k", "missing"],
  })),
  ...[
    null,
    {},
    { op: "unknown", key: "x" },
    { op: "set", key: "x" },
    { op: "get", key: 4 },
  ].map((bad) => ({
    batches: [
      [{ op: "set", key: "old", value: "original" }],
      [
        { op: "set", key: "old", value: "overwritten" },
        { op: "set", key: "new", value: 2 },
        bad,
      ],
    ],
    queries: ["old", "new"],
  })),
  {
    batches: [
      [],
      [
        { op: "set", key: "__proto__", value: { safe: true } },
        { op: "set", key: " 雪 ", value: 0 },
      ],
    ],
    queries: ["__proto__", " 雪 ", "雪"],
  },
  null,
  [],
  {},
  { batches: [], queries: [1] },
  { batches: [null, []], queries: [] },
];
export async function runPipeline(
  directory: string,
  input: unknown,
  node: string,
  tests = false,
) {
  if (process.platform !== "darwin")
    throw Error("Pipeline execution requires macOS sandbox-exec");
  const work = await realpath(await mkdtemp("/private/tmp/kgr-stack-exec-"));
  try {
    await cp(join(directory, "src"), join(work, "src"), { recursive: true });
    if (tests)
      await cp(join(directory, "tests"), join(work, "tests"), {
        recursive: true,
      });
    const args = tests
      ? [
          "--test",
          "--test-isolation=none",
          ...(await readdir(join(work, "tests")))
            .filter((n) => n.endsWith(".test.mjs"))
            .map((n) => join("tests", n)),
        ]
      : [join(work, "src/cli.mjs")];
    const p = Bun.spawn(
      [
        "/usr/bin/sandbox-exec",
        "-p",
        '(version 1)(allow default)(deny network*)(deny file-write*)(deny file-read* (subpath "/Users"))',
        node,
        "--permission",
        `--allow-fs-read=${work}`,
        ...args,
      ],
      {
        cwd: work,
        env: { PATH: process.env.PATH!, NODE_NO_WARNINGS: "1" },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    p.stdin.write(JSON.stringify(input));
    p.stdin.end();
    const timer = setTimeout(() => p.kill("SIGKILL"), 10000);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        readProcessText(p.stdout),
        readProcessText(p.stderr),
        p.exited,
      ]);
      if (tests) return { stdout, stderr, exitCode, passed: exitCode === 0 };
      const expected = expectedPipeline(input);
      let actual: unknown;
      try {
        actual = JSON.parse(stdout);
      } catch {
        actual = { unparseable: stdout };
      }
      return {
        stdout,
        stderr,
        exitCode,
        expected,
        actual,
        passed:
          exitCode === expected.exitCode &&
          stderr === "" &&
          stdout.endsWith("\n") &&
          isDeepStrictEqual(actual, expected.output),
      };
    } finally {
      clearTimeout(timer);
      if (p.exitCode === null) {
        p.kill("SIGKILL");
        await p.exited;
      }
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
