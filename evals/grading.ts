import type {
  ActionName,
  EvalCase,
  GradeCheck,
  GradeResult,
  RunLedger,
} from "./types.ts";

function includesEvery(actual: string[], expected: string[]): boolean {
  return expected.every((value) => actual.includes(value));
}

function actionCount(ledger: RunLedger, action: ActionName): number {
  return ledger.actions.filter((record) => record.action === action).length;
}

export function gradeRun(
  evalCase: EvalCase,
  ledger: RunLedger,
  output: string,
): GradeResult {
  const checks: GradeCheck[] = [];
  const expected = evalCase.expected;

  if (expected.requiredSkills) {
    checks.push({
      name: "required skills",
      passed: includesEvery(ledger.loadedSkills, expected.requiredSkills),
      detail: `required=${expected.requiredSkills.join(",")} actual=${ledger.loadedSkills.join(",")}`,
    });
  }

  if (expected.forbiddenSkills) {
    const usedForbidden = expected.forbiddenSkills.filter((skill) =>
      ledger.loadedSkills.includes(skill),
    );
    checks.push({
      name: "forbidden skills",
      passed: usedForbidden.length === 0,
      detail: `used=${usedForbidden.join(",") || "none"}`,
    });
  }

  if (expected.requiredRegisteredSkills) {
    checks.push({
      name: "required registered skills",
      passed: includesEvery(
        ledger.registeredSkillCalls,
        expected.requiredRegisteredSkills,
      ),
      detail: `required=${expected.requiredRegisteredSkills.join(",")} actual=${ledger.registeredSkillCalls.join(",")}`,
    });
  }

  if (expected.requiredActions) {
    const missing = expected.requiredActions.filter(
      (action) => actionCount(ledger, action) === 0,
    );
    checks.push({
      name: "required actions",
      passed: missing.length === 0,
      detail: `missing=${missing.join(",") || "none"}`,
    });
  }

  if (expected.requiredAnyActions) {
    const performed = expected.requiredAnyActions.filter(
      (action) => actionCount(ledger, action) > 0,
    );
    checks.push({
      name: "required action alternative",
      passed: performed.length > 0,
      detail: `any=${expected.requiredAnyActions.join(",")} performed=${performed.join(",") || "none"}`,
    });
  }

  if (expected.forbiddenActions) {
    const performed = expected.forbiddenActions.filter(
      (action) => actionCount(ledger, action) > 0,
    );
    checks.push({
      name: "forbidden actions",
      passed: performed.length === 0,
      detail: `performed=${performed.join(",") || "none"}`,
    });
  }

  if (expected.maxActionCounts) {
    for (const [action, maximum] of Object.entries(expected.maxActionCounts)) {
      const count = actionCount(ledger, action as ActionName);
      checks.push({
        name: `maximum ${action}`,
        passed: count <= maximum,
        detail: `maximum=${maximum} actual=${count}`,
      });
    }
  }

  for (const pattern of expected.outputPatterns ?? []) {
    checks.push({
      name: `output matches /${pattern}/i`,
      passed: new RegExp(pattern, "i").test(output),
      detail: `pattern=${pattern}`,
    });
  }

  for (const pattern of expected.forbiddenOutputPatterns ?? []) {
    checks.push({
      name: `output excludes /${pattern}/i`,
      passed: !new RegExp(pattern, "i").test(output),
      detail: `pattern=${pattern}`,
    });
  }

  return {
    passed: checks.every((check) => check.passed),
    checks,
  };
}

export function validateCases(
  cases: EvalCase[],
  availableSkills: Set<string>,
): void {
  const ids = new Set<string>();

  for (const evalCase of cases) {
    if (ids.has(evalCase.id)) {
      throw new Error(`Duplicate eval case id: ${evalCase.id}`);
    }
    ids.add(evalCase.id);

    for (const skill of evalCase.expected.requiredSkills ?? []) {
      if (!availableSkills.has(skill)) {
        throw new Error(`${evalCase.id} requires missing skill ${skill}`);
      }
    }

    for (const registeredSkill of
      evalCase.expected.requiredRegisteredSkills ?? []) {
      if (!evalCase.fixture.registeredSkills?.[registeredSkill]) {
        throw new Error(
          `${evalCase.id} requires unregistered skill ${registeredSkill}`,
        );
      }
    }

    const forbiddenActions = new Set(
      evalCase.expected.forbiddenActions ?? [],
    );
    for (const action of evalCase.expected.requiredActions ?? []) {
      if (forbiddenActions.has(action)) {
        throw new Error(
          `${evalCase.id} both requires and forbids action ${action}`,
        );
      }
    }
    for (const action of evalCase.expected.requiredAnyActions ?? []) {
      if (forbiddenActions.has(action)) {
        throw new Error(
          `${evalCase.id} both accepts and forbids action ${action}`,
        );
      }
    }
  }
}
