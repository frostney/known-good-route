import type { EvalRunRecord } from "./types.ts";

function tableCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");
}

export function renderSummary(records: EvalRunRecord[]): string {
  const passed = records.filter((record) => record.grade.passed).length;
  const lines = [
    "# Skill eval results",
    "",
    `Passed **${passed}/${records.length}** rows.`,
    "",
    "| Model | Case | Run | Result | Tokens |",
    "| --- | --- | ---: | --- | ---: |",
  ];

  for (const record of records) {
    lines.push(
      `| ${tableCell(record.model)} | ${tableCell(record.caseId)} | ${record.repetition} | ${record.grade.passed ? "PASS" : "FAIL"} | ${record.usage?.totalTokens ?? "n/a"} |`,
    );
  }

  const failures = records.filter((record) => !record.grade.passed);
  lines.push("", "## Failures", "");
  if (failures.length === 0) {
    lines.push("All evaluated rows passed.");
  } else {
    for (const record of failures) {
      const failedChecks = record.grade.checks
        .filter((check) => !check.passed)
        .map((check) => check.name)
        .join(", ");
      lines.push(
        `- \`${record.model}\` / \`${record.caseId}\` #${record.repetition}: ${failedChecks || "run failed"}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}
