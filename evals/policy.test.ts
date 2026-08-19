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

  test("PR feedback repeats specification and functional validation before push", async () => {
    const source = await skill("address-pr-feedback");

    expect(source).toContain("record linking each requirement to its evidence");
    expect(source).toMatch(/real\s+delivered\s+interface/);
    expect(source).toContain("pre-PR gate");
    expect(source).toContain("/code-review fix-all");
    expect(source).toContain("same unchanged change");
  });

  test("writing guidance uses revision thresholds and conditional detail", async () => {
    const source = await skill("agent-writing");

    expect(source).toContain("never as targets to fill");
    expect(source).toContain("no minimum length");
    expect(source).toContain("over 60 words");
    expect(source).toContain("over 250 words");
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
