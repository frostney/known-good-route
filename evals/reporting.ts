import { aggregateRepeats, rowOutcome } from "./judge.ts";
import type { EvalRunRecord } from "./types.ts";

function tableCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");
}

const label = { pass: "PASS", fail: "FAIL", review: "NEEDS HUMAN REVIEW", error: "ERROR" };

export function renderSummary(records: EvalRunRecord[], repeat = 1): string {
  const aggregates = aggregateRepeats(records, repeat);
  const passedCases = aggregates.filter((a) => a.outcome === "pass").length;
  const discovery = records.flatMap((r) =>
    r.grade.checks.filter((c) => c.category === "discovery"),
  );
  const lines = [
    "# Skill eval results",
    "",
    `Cases passing all ${repeat} repeat(s): **${passedCases}/${aggregates.length}**. A case passes only when every repeat passes.`,
    `Discovery diagnostics: ${discovery.filter((c) => c.passed).length}/${discovery.length}; reported separately from outcome/contract grades.`,
    "",
    "| Model | Effort | Case | Pass | Fail | Review | Error | Result |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const a of aggregates)
    lines.push(
      `| ${tableCell(a.model)} | ${tableCell(a.effort)} | ${tableCell(a.caseId)} | ${a.counts.pass} | ${a.counts.fail} | ${a.counts.review} | ${a.counts.error} | ${a.runs < repeat ? `INCOMPLETE (${a.runs}/${repeat})` : label[a.outcome]} |`,
    );

  lines.push(
    "",
    "## Runs",
    "",
    "| Model | Effort | Case | Run | Result | Judge | Tokens |",
    "| --- | --- | --- | ---: | --- | --- | ---: |",
  );
  for (const record of records) {
    const judge = record.judgement
      ? `${record.judgement.judge}${record.judgement.trusted ? "" : record.judgement.crossFamily ? " (uncalibrated)" : " (same family)"}`
      : "n/a";
    lines.push(
      `| ${tableCell(record.model)} | ${tableCell(record.effort ?? "unspecified")} | ${tableCell(record.caseId)} | ${record.repetition} | ${label[rowOutcome(record)]} | ${tableCell(judge)} | ${record.usage?.totalTokens ?? "n/a"} |`,
    );
  }

  const section = (title: string, outcome: "fail" | "review" | "error", empty: string) => {
    const rows = records.filter((record) => rowOutcome(record) === outcome);
    lines.push("", `## ${title}`, "");
    if (!rows.length) {
      lines.push(empty);
      return;
    }
    for (const record of rows) {
      const failed = record.grade.checks
        .filter((check) => !check.passed && check.category !== "discovery")
        .map((check) => (check.category === "rubric" ? `${check.name} (${check.detail})` : check.name))
        .join(", ");
      lines.push(
        `- \`${record.model}\` / \`${record.caseId}\` #${record.repetition}: ${tableCell(failed || record.error || "run failed")}`,
      );
    }
  };
  section("Failures", "fail", "No run failed.");
  section(
    "Needs human review",
    "review",
    "No judge failure awaits human review.",
  );
  lines.push(
    "",
    "Judge failures need human review while the judge is uncalibrated or shares the run's model family; they do not count as failures.",
  );
  section("Errors", "error", "No run or judge error.");
  return `${lines.join("\n")}\n`;
}
