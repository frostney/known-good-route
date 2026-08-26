import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");

async function skill(name: string): Promise<string> {
  return Bun.file(resolve(repositoryRoot, name, "SKILL.md")).text();
}

describe("cross-skill policy", () => {
  test("implementation options share evidence and validation before selection", async () => {
    for (const name of ["implement-idea", "implement-issue"]) {
      const source = await skill(name);
      expect(source).toContain("one neutral evidence packet");
      expect(source).toContain("Define one comparison rubric");
      expect(source).toMatch(/equivalent\s+decision-relevant validation/);
      expect(source).toContain("Do not select an option until");
      expect(source.indexOf("Compare first")).toBeLessThan(
        source.indexOf("recommend only afterward"),
      );
    }
  });

  test("interactive implementation reviews require structured HTML and grilling", async () => {
    for (const name of ["implement-idea", "implement-issue"]) {
      const source = await skill(name);
      expect(source).toContain("require the registered `grilling` and `render-html`");
      expect(source).toContain("temporary interactive impact report");
      expect(source).toContain("pros, cons, scores, uncertainties");
      expect(source).toContain("absolute path and continue");
      expect(source).toMatch(/remove\s+the temporary report/i);
      expect(source).toMatch(
        /Automatic mode[\s\S]*skips the interactive HTML report and `grilling`/,
      );
    }
  });

  test("retrospectives delegate durable report rendering", async () => {
    const source = await skill("run-retro");

    expect(source).toContain("Requires registered grilling and render-html skills");
    expect(source).toContain("The report is a durable retrospective artifact");
    expect(source).toContain("Read the `render-html` schema");
    expect(source).not.toContain("render_retro.py");
  });

  test("retrospectives trace process origins and gate immediate implementation", async () => {
    const source = await skill("run-retro");

    expect(source).toMatch(/originating\s+decision/);
    expect(source).toContain("implementation drift");
    expect(source).toContain("documentation drift");
    expect(source).toContain("complete available coordinator and subagent record");
    expect(source).toContain("no-value context separately");
    expect(source).toContain("explicit user selection");
    expect(source).toContain("normal `implement-issue`");
    expect(source).toContain("retrospective active");
  });

  test("milestone telemetry stays normalized, one-shot, and provider neutral", async () => {
    const source = await skill("milestone-rush");
    const reference = await Bun.file(
      resolve(repositoryRoot, "milestone-rush/references/event-ledger.md"),
    ).text();

    expect(source).toContain("event-ledger `ingest` command");
    expect(source).toContain("event-ledger `validate` and `summarize` commands");
    expect(source).toMatch(/never add provider transcript\s+parsers/);
    expect(reference).toContain("one-shot command");
    expect(reference).toContain('"mode": "delta | snapshot"');
    expect(reference).toContain("Schema-v1 lifecycle events remain readable");
    expect(reference).toMatch(/contains no provider\s+transcript parser/);
  });

  test("GitHub prose uses exact attributed Notes", async () => {
    const note = "> [!NOTE]\n   > Created on behalf of @username using ModelName.";
    const createIssue = await skill("create-issue");
    const addressPrFeedback = await skill("address-pr-feedback");

    expect(createIssue).toContain(note);
    expect(addressPrFeedback).toContain(note.replace("   >", "  >"));
    expect(createIssue).toMatch(/Stop if either is\s+unavailable/);
    expect(addressPrFeedback).toContain("exact automation retrigger command");
    expect(addressPrFeedback).toContain("300 characters or fewer");
  });

  test("PR feedback repeats code review and black-box testing before the project gate", async () => {
    const source = await skill("address-pr-feedback");

    expect(source).toContain("/code-review fix-all");
    expect(source).toContain("/test-against-spec fix");
    expect(source).toContain("exact-revision preview deployment");
    expect(source).toContain("same unchanged implementation");
    expect(source.indexOf("/code-review fix-all")).toBeLessThan(
      source.indexOf("/test-against-spec fix"),
    );
    expect(source.indexOf("/test-against-spec fix")).toBeLessThan(
      source.indexOf("declared pre-PR gate"),
    );
  });

  test("stack feedback freezes reviewed heads and admits only the complete stack", async () => {
    const source = await skill("address-stack-feedback");
    const readiness = await Bun.file(
      resolve(repositoryRoot, "address-stack-feedback/references/readiness.md"),
    ).text();

    expect(source).toContain("one repository-scoped native stack number");
    expect(source).toContain("Review every initial member once for its exact head");
    expect(source).toContain("create exactly one new branch above the current top");
    expect(source).toContain("never push those fixes into any frozen member");
    expect(source).toContain("Never merge, enqueue, enable automatic merge, buy review capacity");
    expect(source).toMatch(/The exact\s+`read-only` qualifier disables every mutation/);
    expect(readiness).toContain("A covered lower member can still contain the reported flaw");
    expect(readiness).toMatch(/never returns\s+`merged`/);
  });

  test("stack feedback keeps CodeRabbit behavior in executable adapter code", async () => {
    const source = await skill("address-stack-feedback");
    const adapter = await Bun.file(
      resolve(
        repositoryRoot,
        "address-stack-feedback/scripts/coderabbit_adapter.py",
      ),
    ).text();

    expect(source).toContain("Provider-neutral behavior is the default");
    expect(source).toMatch(/does not\s+own stack identity, findings, fixes, readiness/);
    expect(source).toContain("scripts/coderabbit_adapter.py");
    expect(source).toContain("do not reconstruct its trigger, completion");
    expect(source).not.toContain("references/coderabbit.md");
    expect(adapter).toContain('"@coderabbitai review"');
    expect(adapter).toContain('"@coderabbitai full review"');
    expect(adapter).toContain("updated_at");
    expect(adapter).toContain("fcntl.LOCK_EX");
    expect(adapter).not.toContain("usage-based");
  });

  test("milestone rush delegates a native stack once and retains merge authority", async () => {
    const source = await skill("milestone-rush");

    expect(source).toContain("/address-stack-feedback\n   <stack-number>` once");
    expect(source).toContain("complete ready stack through `git-workflow`");
    expect(source).toContain("Never\n   merge a prefix beneath a required top fix layer");
  });

  test("implementation owns the review and behavior-testing loop", async () => {
    for (const name of ["implement-idea", "implement-issue"]) {
      const source = await skill(name);
      expect(source).toContain("/code-review fix-all");
      expect(source).toContain("/test-against-spec fix");
      expect(source).toContain("same unchanged implementation");
      expect(source).toMatch(/If fixing a gate\s+failure changes the implementation, return to step/);
    }
  });

  test("implementation remains active while safe authorized work remains", async () => {
    for (const name of ["implement-idea", "implement-issue"]) {
      const source = await skill(name);
      expect(source).toContain("keep the authorized implementation");
      expect(source).toContain("A known fix or recommendation is not terminal");
      expect(source).toContain("active-implementation terminal check");
      expect(source).toMatch(/Continue with the next safe authorized action/);
    }

    const excellence = await skill("software-engineering-excellence");
    expect(excellence).toContain("Active implementation completion");
    expect(excellence).toContain("A diagnosis, recommended");
    expect(excellence).toContain("next safe executable action");
  });

  test("model-facing contracts prove offline downstream containment", async () => {
    for (const name of ["implement-idea", "implement-issue"]) {
      const source = await skill(name);
      expect(source).toContain("contract containment");
      expect(source).toContain("offline gate");
      expect(source).toMatch(/before any production, live, or paid evaluation/);
    }

    const review = await skill("code-review");
    expect(review).toContain("actual advertised schema");
    expect(review).toMatch(/offline\s+differential containment/);

    const reference = await Bun.file(
      resolve(
        repositoryRoot,
        "software-engineering-excellence/references/contract-containment.md",
      ),
    ).text();
    expect(reference).toContain("every payload accepted");
    expect(reference).toContain("actual serialized or advertised upstream schema");
    expect(reference).toContain("sanitized recorded payloads");
    expect(reference).toContain("Do not use a production, live, or paid model run");
  });

  test("behavior testing is black-box, preview-first, and read-only by default", async () => {
    const source = await skill("test-against-spec");

    expect(source).toContain("Report by default");
    expect(source).toContain("exact `fix` qualifier");
    expect(source).toMatch(/Never\s+infer it from the implementation/);
    expect(source).toContain("Do not use implementation source");
    expect(source).toContain("Prefer a preview deployment");
    expect(source).toContain("report the fix as applied but unverified");
    expect(source).toContain("does not replace source review");
  });

  test("create-pr publishes completion evidence without testing or fixing implementation", async () => {
    const source = await skill("create-pr");

    expect(source).toContain("completion evidence supplied by");
    expect(source).toContain("Do not test delivered behavior");
    expect(source).toMatch(/Do not fix it\s+here/);
    expect(source).toContain("explicit user request for a draft PR");
    expect(source).toContain("preview tied to its exact revision");
    expect(source).not.toContain("/test-against-spec");
  });

  test("writing guidance uses revision thresholds and conditional detail", async () => {
    const source = await skill("agent-writing");

    expect(source).toContain("never as targets to fill");
    expect(source).toContain("no minimum length");
    expect(source).toContain("over 120 words");
    expect(source).toContain("over 60 words");
    expect(source).toContain("over 250 words");
    expect(source).toContain("Revise before sending");
    expect(source).toContain("application-generated reports");
    expect(source).toContain("Reserve `byte-identical` for compiler or binary output");
    expect(source).toContain("references/generated-writing-patterns.md");
    expect(source).not.toContain("Target about 300 characters per item");
  });

  test("writing guidance replaces compressed labels with specific wording", async () => {
    const source = await Bun.file(
      resolve(
        repositoryRoot,
        "agent-writing/references/generated-writing-patterns.md",
      ),
    ).text();

    expect(source).toContain("Coined labels that compress a multi-step process");
    expect(source).toContain("requirements for marking the PR ready");
    expect(source).toContain("time from making an edit to reliable evidence");
    expect(source).toContain("Preserve quoted headings, fixture keys, and code identifiers");
  });

  test("git titles state impact", async () => {
    const source = await skill("git-workflow");

    expect(source).toContain("Each commit title");
    expect(source).toContain("observable impact");
    expect(source).toContain("pull request **title**");
  });

  test("code review keeps nitpicks canonical but non-blocking", async () => {
    const source = await skill("code-review");
    const findings = await Bun.file(
      resolve(repositoryRoot, "code-review/references/findings-json.md"),
    ).text();

    expect(source).toContain("presentation only");
    expect(source).toContain("NITPICK");
    expect(source).toContain("never blocks PR creation");
    expect(source).toContain("filename including extensionless files");
    expect(findings).toContain(
      "BLOCKING | IMPORTANT | IMPROVEMENT | NITPICK",
    );
  });

  test("Pascal preserves standard initialisms", async () => {
    const source = await Bun.file(
      resolve(repositoryRoot, "native-nostalgia-stack/references/code-style.md"),
    ).text();

    expect(source).toContain("HTTPClient");
    expect(source).toContain("IHTTPTransport");
    expect(source).toContain("TGCRoot");
    expect(source).toContain("external API or explicit project");
  });
});
