import { expect, test } from "bun:test";
import { completedReview } from "./review-receipt.ts";

const review = (attempt = "new", revision = "B") => ({
  attempt,
  revision,
  model: "test-model",
  verdict: "pass",
  findings: [],
});
const event = (attempt = "new", revision = "B") => ({
  action: "reviewProcess",
  attempt,
  revision,
  model: "test-model",
  exitCode: 0,
  completed: true,
  cancellationRequested: false,
  loadedSkills: ["code-review"],
});

test("publication cannot combine an old completed turn with a new failed review", () => {
  const state = {
    reviews: [review("old", "A"), review()],
    events: [
      event("old", "A"),
      { ...event(), error: "failed after submitting" },
    ],
  };
  expect(completedReview(state, "B")).toBeUndefined();
  expect(completedReview(state, "A")).toEqual(review("old", "A"));
});

test("review receipt requires matching attempt, content, model and successful terminal evidence", () => {
  expect(
    completedReview({ reviews: [review()], events: [event()] }, "B"),
  ).toEqual(review());
  for (const patch of [
    { attempt: "other" },
    { attempt: undefined },
    { revision: "A" },
    { model: "other-model" },
    { exitCode: 1 },
    { exitCode: undefined },
    { completed: false },
    { completed: undefined },
    { cancellationRequested: true },
    { loadedSkills: [] },
    { error: "incomplete" },
  ])
    expect(
      completedReview(
        { reviews: [review()], events: [{ ...event(), ...patch }] },
        "B",
      ),
    ).toBeUndefined();
  expect(
    completedReview({ reviews: [review()], events: [] }, "B"),
  ).toBeUndefined();
  expect(
    completedReview(
      { reviews: [{ ...review(), attempt: undefined }], events: [event()] },
      "B",
    ),
  ).toBeUndefined();
});

test("completed native review cannot override a failing verdict or actionable finding", () => {
  for (const patch of [
    { verdict: "fail" },
    { findings: undefined },
    { findings: [{ withinScope: true, severity: "NITPICK" }] },
    { findings: [{ withinScope: false, severity: "IMPORTANT" }] },
  ])
    expect(
      completedReview(
        { reviews: [{ ...review(), ...patch }], events: [event()] },
        "B",
      ),
    ).toBeUndefined();
});
