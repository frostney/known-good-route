// A submitted verdict and a completed native turn are separate evidence.
// Publication needs both from the same attempt against the same content.
export function completedReview(state: any, revision: string) {
  return state.reviews.find(
    (review: any) =>
      typeof review.attempt === "string" &&
      review.attempt.length > 0 &&
      review.revision === revision &&
      review.verdict === "pass" &&
      Array.isArray(review.findings) &&
      review.findings.every(
        (f: any) =>
          f.withinScope === false &&
          !["BLOCKING", "IMPORTANT"].includes(f.severity),
      ) &&
      state.events.some(
        (event: any) =>
          event.action === "reviewProcess" &&
          event.attempt === review.attempt &&
          event.revision === revision &&
          event.model === review.model &&
          event.exitCode === 0 &&
          event.completed === true &&
          !event.error &&
          !event.cancellationRequested &&
          event.loadedSkills?.includes("code-review"),
      ),
  );
}
