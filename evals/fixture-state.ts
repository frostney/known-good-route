import { carriesAll } from "./grading.ts";
import type { ActionName, ActionRecord, EvalFixture } from "./types.ts";

// One run's scripted fixture state: the evidence a source returns and the
// result each recorded action gets. The fixture tool and the review replay
// share it, so both report the same state for the same recorded actions.
export function createFixtureState(fixture: EvalFixture) {
  const evidence = { ...fixture.evidence };
  const responses = { ...fixture.actionResponses };
  // How many times an action had been recorded when a transition installed
  // its response sequence: the sequence starts at the call after that.
  const sequenceStart = new Map<ActionName, number>();
  const recorded: Array<ActionRecord & { result?: string | undefined }> = [];
  const count = (from: number, action: ActionName, path?: string) =>
    recorded.slice(from).filter(
      (r) => r.action === action && (path === undefined || r.data?.path === path),
    ).length;
  return {
    evidence,
    // Returns this call's result: the result of the first matching transition
    // that gives one, else the scripted result, or undefined when the fixture
    // scripts none. A transition's evidence and responses change later calls.
    record(action: ActionName, data?: Record<string, unknown>, details = "") {
      const earlier = [...recorded];
      const call: ActionRecord & { result?: string | undefined } = { action, details, ...(data ? { data } : {}) };
      recorded.push(call);
      const response = responses[action];
      const scripted = Array.isArray(response)
        ? response[Math.min(
            count(0, action) - (sequenceStart.get(action) ?? 0),
            response.length,
          ) - 1]
        : response;
      const applies = (transition: NonNullable<EvalFixture["transitions"]>[number], result: string | undefined) => {
        if (transition.after !== action ||
            (transition.editPath !== undefined &&
             (action !== "file.edit" || data?.path !== transition.editPath))) return false;
        if (transition.whenResult !== undefined && !String(result ?? "").includes(transition.whenResult)) return false;
        const carries = transition.whenCarries;
        if (carries && !carriesAll(call, [carries].flat())) return false;
        if (transition.whenRecorded?.some((need) =>
          !earlier.some((r) => r.action === need.action && carriesAll(r, need.carries ?? []) &&
            (need.withResult === undefined || String(r.result ?? "").includes(need.withResult))))) return false;
        const since = transition.since === undefined ? -1 :
          recorded.findIndex((r) => r.action === transition.since);
        if (transition.since !== undefined && since < 0) return false;
        if ((transition.whenResult === undefined && transition.whenCarries === undefined || transition.occurrence !== undefined) &&
            (transition.occurrence ?? 1) !== count(since + 1, action, transition.editPath)) return false;
        return true;
      };
      // A matching transition with a result replaces this call's own result.
      const result = (fixture.transitions ?? []).find((t) => t.result !== undefined && applies(t, scripted))?.result ?? scripted;
      call.result = result;
      for (const transition of fixture.transitions ?? []) {
        if (!applies(transition, result)) continue;
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
