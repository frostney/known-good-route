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

  test("forge prose uses exact attributed GitHub Notes", async () => {
    const note = "> [!NOTE]\n   > Created on behalf of @username using ModelName.";
    const createIssue = await skill("create-issue");
    const reviewPr = await skill("review-pr");

    expect(createIssue).toContain(note);
    expect(reviewPr).toContain(note.replace("   >", "  >"));
    expect(createIssue).toContain("Stop if either is unavailable");
    expect(reviewPr).toContain("exact automation retrigger command");
    expect(reviewPr).toContain("300 characters or fewer");
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
