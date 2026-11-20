import type { ActionName, EvalFixture } from "./types.ts";

// One run's scripted fixture state: the evidence a source returns and the
// result each recorded action gets. The fixture tool and the review replay
// share it, so both report the same state for the same recorded actions.
export function createFixtureState(fixture: EvalFixture) {
  const evidence = { ...fixture.evidence };
  const responses = { ...fixture.actionResponses };
  // How many times an action had been recorded when a transition installed
  // its response sequence: the sequence starts at the call after that.
  const sequenceStart = new Map<ActionName, number>();
  const recorded: Array<{ action: ActionName; path?: unknown }> = [];
  const count = (from: number, action: ActionName, path?: string) =>
    recorded.slice(from).filter(
      (r) => r.action === action && (path === undefined || r.path === path),
    ).length;
  return {
    evidence,
    // Returns the scripted result of this call, or undefined when the fixture
    // scripts none. A transition changes future results, not its trigger's.
    record(action: ActionName, data?: Record<string, unknown>) {
      recorded.push({ action, path: data?.path });
      const response = responses[action];
      const result = Array.isArray(response)
        ? response[Math.min(
            count(0, action) - (sequenceStart.get(action) ?? 0),
            response.length,
          ) - 1]
        : response;
      for (const transition of fixture.transitions ?? []) {
        if (transition.after !== action ||
            (transition.editPath !== undefined &&
             (action !== "file.edit" || data?.path !== transition.editPath))) continue;
        if (transition.whenResult !== undefined && !String(result ?? "").includes(transition.whenResult)) continue;
        const since = transition.since === undefined ? -1 :
          recorded.findIndex((r) => r.action === transition.since);
        if (transition.since !== undefined && since < 0) continue;
        if ((transition.whenResult === undefined || transition.occurrence !== undefined) &&
            (transition.occurrence ?? 1) !== count(since + 1, action, transition.editPath)) continue;
        Object.assign(evidence, transition.evidence);
        for (const [name, value] of Object.entries(transition.actionResponses ?? {}) as Array<[ActionName, string | string[]]>) {
          responses[name] = value;
          if (Array.isArray(value)) sequenceStart.set(name, count(0, name));
          else sequenceStart.delete(name);
        }
      }
      return result;
    },
  };
}
