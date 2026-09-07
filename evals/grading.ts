import { hasSkillCitation } from "./skill-citation.ts";
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

function actionText(record: RunLedger["actions"][number]): string {
  if (record.action === "report" || record.action === "user.ask")
    return [
      record.details,
      record.data ? JSON.stringify(record.data) : "",
    ].join("\n");
  return [
    record.details,
    typeof record.data?.body === "string" ? record.data.body : "",
  ].join("\n");
}

export function gradeRun(
  evalCase: EvalCase,
  ledger: RunLedger,
  output: string,
): GradeResult {
  // A native final response is observed communication, never proof of a mutation.
  // Append it only in the grading view; preserve the original tool ledger.
  if (output.trim())
    ledger = {
      ...ledger,
      actions: [
        ...ledger.actions,
        { action: "report", details: output, source: "final-response" },
      ],
      events: [...ledger.events, { kind: "action", name: "report" }],
    };
  const checks: GradeCheck[] = [];
  const expected = evalCase.expected;
  for (const requirement of expected.requiredSkillCitations ?? [])
    checks.push({
      name: `${requirement.skill} source citation`,
      passed: hasSkillCitation(ledger, requirement),
      detail: "Require a user-facing link to the captured loaded source path and its required quoted passage in the same communication.",
    });
  if (expected.allowedDelegateWorkflows)
    checks.push({
      name: "delegation scope",
      passed: ledger.actions
        .filter((a) => a.action === "delegate")
        .every(
          (a) =>
            typeof a.data?.workflow === "string" &&
            expected.allowedDelegateWorkflows!.includes(a.data.workflow),
        ),
      detail:
        "Only explicitly scoped administrative workflows may delegate before implementation admission",
    });
  if (expected.decisionPacket) {
    const packet = ledger.actions.findLast(
      (a) => a.action === "report" && a.source !== "final-response",
    )?.data?.decisionPacket as any;
    const nonempty = (s: unknown) =>
      typeof s === "string" && s.trim().length > 0;
    const source = (s: unknown) =>
      nonempty(s) &&
      Object.hasOwn(evalCase.fixture.evidence, s as string) &&
      ledger.inspections.includes(s as string);
    const options = Array.isArray(packet?.options) ? packet.options : [];
    checks.push({
      name: "source-linked decision packet",
      passed: Boolean(
        Array.isArray(packet?.current) &&
        packet.current.length > 0 &&
        packet.current.every(
          (f: any) => f && source(f.source) && nonempty(f.fact),
        ) &&
        options.length >= 2 &&
        options.every(
          (o: any) =>
            o &&
            nonempty(o.id) &&
            nonempty(o.benefit) &&
            nonempty(o.cost) &&
            nonempty(o.uncertainty) &&
            Array.isArray(o.sources) &&
            o.sources.length > 0 &&
            o.sources.every(source),
        ) &&
        new Set(options.map((o: any) => o?.id)).size === options.length &&
        options.some((o: any) => o.id === packet.recommendationId),
      ),
      detail:
        "Require observed facts attributed to inspected sources, distinct proposed options with benefit/cost/uncertainty, and a recommendation naming an option. Structure and source availability are checked, not semantic truth.",
    });
  }
  let artifactText = "";
  if (expected.jsonArtifact) {
    const requirement = expected.jsonArtifact;
    const payload = ledger.actions.findLast(
      (a) => a.action === "file.edit" && a.data?.path === requirement.path,
    )?.data?.content;
    let artifact: any;
    try {
      artifact = typeof payload === "string" ? JSON.parse(payload) : payload;
      if (artifact && typeof artifact === "object")
        artifactText = JSON.stringify(artifact);
    } catch {
      /* Invalid serialized content must fail, even if prose claims valid JSON. */
    }
    checks.push({
      name: "JSON artifact envelope",
      passed: Boolean(
        artifact &&
        artifact.schemaVersion === requirement.schemaVersion &&
        artifact.kind === requirement.kind &&
        Array.isArray(artifact.findings),
      ),
      detail: `Require parsed ${requirement.kind} v${requirement.schemaVersion} with findings at ${requirement.path}; this checks the envelope, not every schema field.`,
    });
  }
  if (evalCase.execution)
    checks.push({
      name: "executed CLI on final content",
      passed: Boolean(
        ledger.execution?.checks.some(
          (check) =>
            check.passed && check.revision === ledger.execution!.revision,
        ),
      ),
      detail:
        "Require a host-observed successful CLI check whose content hash matches the final application; action prose is insufficient.",
    });
  if (expected.allowedEditPaths)
    checks.push({
      name: "file edit scope",
      passed: ledger.actions
        .filter((a) => a.action === "file.edit")
        .every(
          (a) =>
            typeof a.data?.path === "string" &&
            expected.allowedEditPaths!.includes(a.data.path),
        ),
      detail: `Allowed exact paths: ${expected.allowedEditPaths.join(",")}`,
    });
  if (expected.discoverySkills)
    checks.push({
      name: "skill discovery",
      category: "discovery",
      passed: includesEvery(ledger.loadedSkills, expected.discoverySkills),
      detail: `suggested=${expected.discoverySkills.join(",")} loaded=${ledger.loadedSkills.join(",")}`,
    });
  if (expected.requiredWorker) {
    const workers = ledger.workers ?? [];
    checks.push({
      name: "native worker contract",
      passed:
        workers.length === 1 &&
        workers.every(
          (worker) =>
            !!evalCase.worker &&
            worker.model === evalCase.worker.model &&
            worker.caseId === evalCase.worker.caseId &&
            worker.mode === (evalCase.worker.mode ?? "process") &&
            !!worker.context.trim() &&
            !!worker.instructions?.trim() &&
            !!worker.output.trim() &&
            !worker.error &&
            !worker.ledger.workers?.length &&
            worker.grade.passed &&
            worker.grade.checks.every((check) => check.passed) &&
            !!worker.responseModels?.length &&
            worker.responseModels.every(
              (model) => model === evalCase.worker!.model.split(":")[1],
            ),
        ),
      detail: `observed workers=${workers.length}; require the configured task/mode, actual response identity, completed output and consistently passing worker checks; transcript binding is verified separately`,
    });
  }

  for (const requirement of expected.requiredActionDetails ?? []) {
    const details = ledger.actions
      .filter((a) => a.action === requirement.action)
      .map((a) =>
        [
          actionText(a),
          ...(requirement.dataFields ?? []).map((field) => {
            const value = a.data?.[field];
            return value === undefined
              ? ""
              : typeof value === "string"
                ? value
                : JSON.stringify(value);
          }),
        ].join("\n"),
      );
    const matches = (text: string) =>
      requirement.patterns.every((pattern) =>
        new RegExp(pattern, "i").test(text),
      );
    checks.push({
      name: `${requirement.action} evidence`,
      passed:
        details.length > 0 &&
        (requirement.every ? details.every(matches) : details.some(matches)),
      detail: `patterns=${requirement.patterns.join(",")}; receipts=${details.length}`,
    });
  }
  const report = [
    output,
    artifactText,
    ...ledger.actions
      .filter((a) =>
        [
          "report",
          "user.ask",
          "forge.replyInline",
          "forge.commentPr",
          "forge.commentIssue",
        ].includes(a.action),
      )
      .map(actionText),
  ].join("\n");
  for (const pattern of expected.reportPatterns ?? [])
    checks.push({
      name: `report evidence matches /${pattern}/i`,
      passed: new RegExp(pattern, "is").test(report),
      detail: `pattern=${pattern}`,
    });

  if (expected.requiredSkills) {
    checks.push({
      name: "required skills",
      passed: includesEvery(ledger.loadedSkills, expected.requiredSkills),
      detail: `required=${expected.requiredSkills.join(",")} actual=${ledger.loadedSkills.join(",")}`,
    });
  }

  if (expected.requiredAnySkills) {
    const used = expected.requiredAnySkills.filter((skill) =>
      ledger.loadedSkills.includes(skill),
    );
    checks.push({
      name: "required skill alternative",
      passed: used.length > 0,
      detail: `any=${expected.requiredAnySkills.join(",")} used=${used.join(",") || "none"}`,
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

  if (expected.requiredInspections) {
    checks.push({
      name: "required inspections",
      passed: includesEvery(ledger.inspections, expected.requiredInspections),
      detail: `required=${expected.requiredInspections.join(",")} actual=${ledger.inspections.join(",")}`,
    });
  }

  if (expected.requiredReferences) {
    checks.push({
      name: "required references",
      passed: includesEvery(
        ledger.loadedReferences,
        expected.requiredReferences,
      ),
      detail: `required=${expected.requiredReferences.join(",")} actual=${ledger.loadedReferences.join(",")}`,
    });
  }

  for (const order of expected.requiredInspectionsBeforeActions ?? []) {
    const inspectionIndex = ledger.events.findIndex(
      (event) => event.kind === "inspection" && event.name === order.inspection,
    );
    const actionIndex = ledger.events.findIndex(
      (event) => event.kind === "action" && event.name === order.action,
    );
    checks.push({
      name: `${order.inspection} before ${order.action}`,
      passed:
        inspectionIndex >= 0 &&
        actionIndex >= 0 &&
        inspectionIndex < actionIndex,
      detail: `inspectionIndex=${inspectionIndex} actionIndex=${actionIndex}`,
    });
  }

  for (const order of expected.requiredSkillsBeforeActions ?? []) {
    const skillIndex = ledger.events.findIndex(
      (event) => event.kind === "skill" && event.name === order.skill,
    );
    const actionIndex = ledger.events.findIndex(
      (event) => event.kind === "action" && event.name === order.action,
    );
    checks.push({
      name: `${order.skill} before ${order.action}`,
      passed: skillIndex >= 0 && actionIndex >= 0 && skillIndex < actionIndex,
      detail: `skillIndex=${skillIndex} actionIndex=${actionIndex}`,
    });
  }

  for (const order of expected.requiredActionsBeforeActions ?? []) {
    const beforeIndex = ledger.events.findIndex(
      (event) => event.kind === "action" && event.name === order.before,
    );
    const afterIndex = ledger.events.findIndex(
      (event) => event.kind === "action" && event.name === order.after,
    );
    checks.push({
      name: `${order.before} before ${order.after}`,
      passed: beforeIndex >= 0 && afterIndex >= 0 && beforeIndex < afterIndex,
      detail: `beforeIndex=${beforeIndex} afterIndex=${afterIndex}`,
    });
  }

  if (expected.requiredActionSequence) {
    let sequenceIndex = 0;
    for (const event of ledger.events) {
      if (
        event.kind === "action" &&
        event.name === expected.requiredActionSequence[sequenceIndex]
      ) {
        sequenceIndex += 1;
      }
    }
    checks.push({
      name: "required action sequence",
      passed: sequenceIndex === expected.requiredActionSequence.length,
      detail: `required=${expected.requiredActionSequence.join(",")} matched=${sequenceIndex}`,
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

  if (expected.minActionCounts) {
    for (const [action, minimum] of Object.entries(expected.minActionCounts)) {
      const count = actionCount(ledger, action as ActionName);
      checks.push({
        name: `minimum ${action}`,
        passed: count >= minimum,
        detail: `minimum=${minimum} actual=${count}`,
      });
    }
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
    passed: checks.every(
      (check) => check.category === "discovery" || check.passed,
    ),
    checks,
  };
}

export function validateCases(
  cases: EvalCase[],
  availableSkills: Set<string>,
  caseCatalog: EvalCase[] = cases,
): void {
  const ids = new Set<string>();

  for (const evalCase of cases) {
    if (ids.has(evalCase.id)) {
      throw new Error(`Duplicate eval case id: ${evalCase.id}`);
    }
    ids.add(evalCase.id);

    for (const pattern of [
      ...(evalCase.expected.outputPatterns ?? []),
      ...(evalCase.expected.reportPatterns ?? []),
      ...(evalCase.expected.forbiddenOutputPatterns ?? []),
      ...(evalCase.expected.requiredActionDetails ?? []).flatMap(
        (r) => r.patterns,
      ),
    ]) {
      try {
        new RegExp(pattern, "is");
      } catch {
        throw new Error(`${evalCase.id}: invalid assertion pattern ${pattern}`);
      }
    }
    for (const citation of evalCase.expected.requiredSkillCitations ?? []) {
      if (!availableSkills.has(citation.skill) || !citation.passage.trim())
        throw new Error(`${evalCase.id}: invalid skill citation requirement`);
      if (evalCase.expected.forbiddenSkills?.includes(citation.skill))
        throw new Error(`${evalCase.id}: cited skill is forbidden`);
    }
    for (const skill of evalCase.expected.discoverySkills ?? [])
      if (!availableSkills.has(skill))
        throw new Error(`${evalCase.id}: unknown discovery skill ${skill}`);
    for (const transition of evalCase.fixture.transitions ?? [])
      if (
        !Number.isSafeInteger(transition.occurrence ?? 1) ||
        (transition.occurrence ?? 1) < 1
      )
        throw new Error(`${evalCase.id}: invalid transition occurrence`);
    for (const response of Object.values(
      evalCase.fixture.actionResponses ?? {},
    ))
      if (Array.isArray(response) && response.length === 0)
        throw new Error(`${evalCase.id}: empty action response sequence`);
    if (evalCase.worker) {
      const child = caseCatalog.find((c) => c.id === evalCase.worker!.caseId);
      if (!child || child.worker)
        throw new Error(`${evalCase.id}: missing or recursive worker case`);
    }

    for (const skill of evalCase.expected.requiredSkills ?? []) {
      if (evalCase.expected.forbiddenSkills?.includes(skill))
        throw new Error(
          `${evalCase.id} both requires and forbids skill ${skill}`,
        );
      if (!availableSkills.has(skill)) {
        throw new Error(`${evalCase.id} requires missing skill ${skill}`);
      }
    }
    for (const skill of evalCase.expected.requiredAnySkills ?? []) {
      if (!availableSkills.has(skill)) {
        throw new Error(`${evalCase.id} accepts missing skill ${skill}`);
      }
      if (evalCase.expected.forbiddenSkills?.includes(skill)) {
        throw new Error(
          `${evalCase.id} both accepts and forbids skill ${skill}`,
        );
      }
    }

    for (const registeredSkill of evalCase.expected.requiredRegisteredSkills ??
      []) {
      if (!evalCase.fixture.registeredSkills?.[registeredSkill]) {
        throw new Error(
          `${evalCase.id} requires unregistered skill ${registeredSkill}`,
        );
      }
    }

    for (const inspection of evalCase.expected.requiredInspections ?? []) {
      if (evalCase.fixture.evidence[inspection] === undefined) {
        throw new Error(
          `${evalCase.id} requires unavailable inspection ${inspection}`,
        );
      }
    }

    for (const order of evalCase.expected.requiredInspectionsBeforeActions ??
      []) {
      if (evalCase.fixture.evidence[order.inspection] === undefined) {
        throw new Error(
          `${evalCase.id} orders unavailable inspection ${order.inspection}`,
        );
      }
    }

    const forbiddenActions = new Set(evalCase.expected.forbiddenActions ?? []);
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
