#!/usr/bin/env python3
"""Behavioral tests for the executable CodeRabbit adapter."""

from __future__ import annotations

import importlib.util
import unittest
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = (
    ROOT / "address-feedback" / "scripts" / "coderabbit_adapter.py"
)
SPEC = importlib.util.spec_from_file_location("coderabbit_adapter", MODULE_PATH)
assert SPEC and SPEC.loader
ADAPTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ADAPTER)


def iso(seconds: int) -> str:
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat().replace(
        "+00:00", "Z"
    )


START = int(datetime(2026, 8, 21, tzinfo=timezone.utc).timestamp())


class FakeMetrics:
    def __init__(self) -> None:
        self.retries = 0


class FakeGh:
    def __init__(self) -> None:
        self.metrics = FakeMetrics()
        self.values: dict[str, Any] = {}
        self.pages: dict[str, list[list[dict[str, Any]]]] = {}
        self.posts: list[tuple[str, dict[str, str]]] = []
        self.on_post: Callable[[str, dict[str, str]], None] | None = None

    def rest(
        self,
        endpoint: str,
        method: str = "GET",
        fields: dict[str, str] | None = None,
    ) -> Any:
        if method == "POST":
            payload = fields or {}
            self.posts.append((endpoint, payload))
            if self.on_post:
                self.on_post(endpoint, payload)
            return {"id": 900 + len(self.posts)}
        return self.values[endpoint]

    def rest_pages(self, endpoint: str) -> list[Any]:
        return self.pages.get(endpoint, [[]])


def comment(
    identifier: int,
    body: str,
    created: int,
    *,
    bot: bool = True,
    updated: int | None = None,
    issue_url: str = "https://api.github.test/repos/owner/repo/issues/7",
) -> dict[str, Any]:
    return {
        "id": identifier,
        "user": {"login": "coderabbitai[bot]" if bot else "maintainer"},
        "body": body,
        "created_at": iso(created),
        "updated_at": iso(updated if updated is not None else created),
        "issue_url": issue_url,
    }


def review(
    identifier: int,
    body: str,
    head: str = "head-7",
    state: str = "COMMENTED",
) -> dict[str, Any]:
    return {
        "id": identifier,
        "user": {"login": "coderabbitai[bot]"},
        "body": body,
        "state": state,
        "commit_id": head,
        "submitted_at": iso(START + 120),
    }


def configured_gh(
    *,
    comments: list[dict[str, Any]] | None = None,
    reviews: list[dict[str, Any]] | None = None,
    head: str = "head-7",
    coderabbit_check_runs: list[dict[str, Any]] | None = None,
    coderabbit_statuses: list[dict[str, Any]] | None = None,
    pushed: int | None = START,
    check_suites_created: list[int] | None = None,
    check_suite_branch: str = "feature",
) -> FakeGh:
    gh = FakeGh()
    gh.values.update(
        {
            "repos/owner/repo/pulls/7": {
                "head": {
                    "sha": head,
                    "ref": "feature",
                    "repo": {"full_name": "owner/repo"},
                }
            },
            f"repos/owner/repo/commits/{head}": {
                "commit": {"committer": {"date": iso(START)}}
            },
        }
    )
    gh.pages.update(
        {
            "repos/owner/repo/issues/comments?sort=updated&direction=desc&per_page=100": [
                []
            ],
            "repos/owner/repo/issues/7/comments?per_page=100": [comments or []],
            "repos/owner/repo/pulls/7/reviews?per_page=100": [reviews or []],
            "repos/owner/repo/pulls/7/files?per_page=100": [
                [{"filename": "src/feature.ts"}]
            ],
            f"repos/owner/repo/commits/{head}/check-runs?per_page=100": [
                {"check_runs": coderabbit_check_runs or []}
            ],
            f"repos/owner/repo/commits/{head}/statuses?per_page=100": [
                coderabbit_statuses or []
            ],
            "repos/owner/repo/activity?ref=refs/heads/feature&per_page=100": [
                [
                    {"after": "previous-head", "timestamp": iso(START - 600)},
                    *(
                        [{"after": head, "timestamp": iso(pushed)}]
                        if pushed is not None
                        else []
                    ),
                ]
            ],
            f"repos/owner/repo/commits/{head}/check-suites?per_page=100": [
                {
                    "check_suites": [
                        {"created_at": iso(created), "head_branch": check_suite_branch}
                        for created in check_suites_created or []
                    ]
                }
            ],
        }
    )
    return gh


def classify(gh: FakeGh, now: int = START + 180) -> tuple[str, str, str | None]:
    evidence = ADAPTER.pull_evidence(gh, "owner/repo", 7)
    return ADAPTER.classify(evidence, "head-7", None, now)


class CodeRabbitAdapterTest(unittest.TestCase):
    def test_exact_head_actionable_review_is_completion(self) -> None:
        gh = configured_gh(
            reviews=[review(31, "**Actionable comments posted: 2**")]
        )
        state, _, mode = classify(gh)
        self.assertEqual(state, "review-complete")
        self.assertIsNone(mode)

    def test_pending_review_object_is_not_completion(self) -> None:
        gh = configured_gh(
            reviews=[
                review(
                    31,
                    "Actionable comments posted: 2",
                    state="PENDING",
                )
            ]
        )
        state, _, mode = classify(gh)
        self.assertEqual(state, "trigger-incremental")
        self.assertEqual(mode, "incremental")

    def test_empty_review_and_instant_ack_escalate_to_full(self) -> None:
        comments = [
            comment(10, "@coderabbitai review", START + 60, bot=False),
            comment(11, "Review finished", START + 70),
            comment(
                12,
                "<!-- summarize by coderabbit --> src/feature.ts",
                START + 71,
            ),
        ]
        gh = configured_gh(comments=comments, reviews=[review(32, "")])
        state, _, mode = classify(gh)
        self.assertEqual(state, "trigger-full")
        self.assertEqual(mode, "full")

    def test_skipped_ack_never_completes_review(self) -> None:
        comments = [
            comment(10, "@coderabbitai review", START + 60, bot=False),
            comment(11, "Review skipped: draft pull request", START + 90),
        ]
        gh = configured_gh(comments=comments)
        state, _, mode = classify(gh)
        self.assertEqual(state, "pending-skipped")
        self.assertIsNone(mode)

    def test_newest_edited_wait_wins_across_supplied_repositories(self) -> None:
        gh = FakeGh()
        first = "repos/owner/one/issues/comments?sort=updated&direction=desc&per_page=100"
        second = "repos/owner/two/issues/comments?sort=updated&direction=desc&per_page=100"
        gh.pages[first] = [[comment(1, "Next review available in: 9 minutes", START, updated=START + 30)]]
        gh.pages[second] = [[
            comment(
                2,
                "**Next review available in:** **2 minutes**",
                START,
                updated=START + 60,
                issue_url="https://api.github.test/repos/owner/two/issues/88",
            )
        ]]
        wait = ADAPTER.account_wait(gh, ["owner/one", "owner/two"])
        self.assertIsNotNone(wait)
        assert wait
        self.assertEqual(wait["repo"], "owner/two")
        self.assertEqual(wait["pr"], 88)
        self.assertEqual(wait["retryAtEpoch"], START + 60 + 120 + 60)

    def test_rate_limit_without_stated_wait_has_no_guessed_retry(self) -> None:
        comments = [
            comment(10, "@coderabbitai review", START + 60, bot=False),
            comment(11, "Action not completed: review rate limited", START + 90),
        ]
        gh = configured_gh(comments=comments)
        state, reason, mode = classify(gh)
        self.assertEqual(state, "pending-retry-source")
        self.assertIn("without a stated retry time", reason)
        self.assertIsNone(mode)

    def test_stale_elapsed_wait_does_not_authorize_a_new_rate_limit_retry(self) -> None:
        comments = [
            comment(10, "@coderabbitai review", START + 120, bot=False),
            comment(11, "Action not completed: review rate limited", START + 150),
        ]
        gh = configured_gh(comments=comments)
        evidence = ADAPTER.pull_evidence(gh, "owner/repo", 7)
        stale_wait = {
            "updatedAtEpoch": START + 60,
            "retryAtEpoch": START + 90,
        }
        state, reason, mode = ADAPTER.classify(
            evidence, "head-7", stale_wait, START + 180
        )
        self.assertEqual(state, "pending-retry-source")
        self.assertIn("without a stated retry time", reason)
        self.assertIsNone(mode)

    def test_full_review_refusal_stops_instead_of_retriggering(self) -> None:
        comments = [
            comment(10, "@coderabbitai full review", START + 60, bot=False),
            comment(
                11,
                "Action not completed. These commits are already reviewed.",
                START + 90,
            ),
        ]
        gh = configured_gh(comments=comments)
        state, _, mode = classify(gh)
        self.assertEqual(state, "pending-full-refused")
        self.assertIsNone(mode)

    def test_untrusted_full_review_ack_stops_instead_of_retriggering(self) -> None:
        comments = [
            comment(10, "@coderabbitai full review", START + 60, bot=False),
            comment(11, "Review finished", START + 70),
        ]
        gh = configured_gh(comments=comments)
        state, _, mode = classify(gh)
        self.assertEqual(state, "pending-full-unverified")
        self.assertIsNone(mode)

    def test_changed_head_invalidates_expected_review(self) -> None:
        gh = configured_gh(head="new-head")
        evidence = ADAPTER.pull_evidence(gh, "owner/repo", 7)
        state, reason, mode = ADAPTER.classify(
            evidence, "head-7", None, START + 180
        )
        self.assertEqual(state, "invalidated")
        self.assertIn("new-head", reason)
        self.assertIsNone(mode)

    def test_run_posts_one_safe_incremental_trigger_then_observes_review(self) -> None:
        gh = configured_gh()
        clock = [float(START + 180)]

        def after_post(_endpoint: str, payload: dict[str, str]) -> None:
            self.assertEqual(payload["body"], "@coderabbitai review")
            gh.pages["repos/owner/repo/pulls/7/reviews?per_page=100"] = [[
                review(33, "Actionable comments posted: 0")
            ]]

        gh.on_post = after_post

        def sleep(seconds: float) -> None:
            clock[0] += seconds

        state, _, evidence = ADAPTER.run_review(
            gh,
            "owner/repo",
            7,
            "head-7",
            ["owner/repo"],
            START + 300,
            10,
            clock=lambda: clock[0],
            sleeper=sleep,
        )
        self.assertEqual(state, "satisfied")
        self.assertEqual(len(gh.posts), 1)
        self.assertEqual(evidence["triggers"][0]["mode"], "incremental")
        self.assertEqual(
            {item["body"] for item in evidence["triggers"]},
            {"@coderabbitai review"},
        )

    def test_adapter_exposes_no_paid_review_command(self) -> None:
        self.assertEqual(
            set(ADAPTER.TRIGGERS.values()),
            {"@coderabbitai review", "@coderabbitai full review"},
        )

    def test_expired_deadline_never_posts_a_trigger(self) -> None:
        gh = configured_gh()
        state, reason, _ = ADAPTER.run_review(
            gh,
            "owner/repo",
            7,
            "head-7",
            ["owner/repo"],
            START + 180,
            10,
            clock=lambda: float(START + 180),
            sleeper=lambda _seconds: None,
        )
        self.assertEqual(state, "pending")
        self.assertIn("before the permitted trigger", reason)
        self.assertEqual(gh.posts, [])

    def test_status_aggregation_surfaces_invalidated_and_pending_members(self) -> None:
        invalidated = {
            "pullRequests": [
                {"state": "review-complete"},
                {"state": "invalidated"},
            ]
        }
        pending = {"pullRequests": [{"state": "trigger-incremental"}]}
        complete = {"pullRequests": [{"state": "clean-complete"}]}
        self.assertEqual(ADAPTER.aggregate_status(invalidated)[0], "invalidated")
        self.assertEqual(ADAPTER.aggregate_status(pending)[0], "pending")
        self.assertEqual(ADAPTER.aggregate_status(complete)[0], "satisfied")

    def test_fast_ack_without_coverage_stays_pending_full_unverified(self) -> None:
        comments = [
            comment(10, "@coderabbitai full review", START + 60, bot=False),
            comment(11, "Review finished", START + 65),
        ]
        gh = configured_gh(comments=comments)
        state, _, mode = classify(gh)
        self.assertEqual(state, "pending-full-unverified")
        self.assertIsNone(mode)

    def test_fast_ack_verified_coverage_with_coderabbit_check_is_clean_complete(
        self,
    ) -> None:
        comments = [
            comment(10, "@coderabbitai full review", START + 60, bot=False),
            comment(11, "Review finished", START + 65),
            comment(
                12,
                "<!-- summarize by coderabbit --> src/feature.ts",
                START + 66,
            ),
        ]
        gh = configured_gh(
            comments=comments,
            coderabbit_statuses=[
                {
                    "context": "CodeRabbit",
                    "state": "success",
                    "created_at": iso(START + 64),
                }
            ],
        )
        evidence = ADAPTER.pull_evidence(gh, "owner/repo", 7)
        self.assertTrue(evidence["codeRabbitCheckSuccess"])
        self.assertEqual(evidence["codeRabbitCheck"]["state"], "SUCCESS")
        state, reason, mode = classify(gh)
        self.assertEqual(state, "clean-complete")
        self.assertIn("CodeRabbit check SUCCESS", reason)
        self.assertIsNone(mode)

    def test_fast_ack_verified_coverage_without_coderabbit_check_stays_unverified(
        self,
    ) -> None:
        comments = [
            comment(10, "@coderabbitai full review", START + 60, bot=False),
            comment(11, "Review finished", START + 65),
            comment(
                12,
                "<!-- summarize by coderabbit --> src/feature.ts",
                START + 66,
            ),
        ]
        gh = configured_gh(comments=comments)
        evidence = ADAPTER.pull_evidence(gh, "owner/repo", 7)
        self.assertFalse(evidence["codeRabbitCheckSuccess"])
        state, _, mode = classify(gh)
        self.assertEqual(state, "pending-full-unverified")
        self.assertIsNone(mode)

    def test_trusted_latency_ack_after_recorded_push_is_clean_complete_without_check(
        self,
    ) -> None:
        comments = [
            comment(10, "@coderabbitai full review", START + 60, bot=False),
            comment(11, "Review finished", START + 100),
            comment(
                12,
                "<!-- summarize by coderabbit --> src/feature.ts",
                START + 101,
            ),
        ]
        gh = configured_gh(comments=comments)
        state, reason, mode = classify(gh)
        self.assertEqual(state, "clean-complete")
        self.assertEqual(
            reason, "finished acknowledgment has current walkthrough coverage"
        )
        self.assertIsNone(mode)

    def ack_before_push(self) -> list[dict[str, Any]]:
        # The commit is made at START, CodeRabbit finishes the previous head at
        # START + 100, and the commit only reaches GitHub at START + 200.
        return [
            comment(11, "Review finished", START + 100),
            comment(
                12,
                "<!-- summarize by coderabbit --> src/feature.ts",
                START + 101,
            ),
        ]

    def test_ack_before_the_head_was_pushed_does_not_complete_review(
        self,
    ) -> None:
        gh = configured_gh(comments=self.ack_before_push(), pushed=START + 200)
        evidence = ADAPTER.pull_evidence(gh, "owner/repo", 7)
        self.assertEqual(evidence["headPushedAt"], iso(START + 200))
        self.assertEqual(evidence["headPushSource"], "activity")
        self.assertIsNone(evidence["finishedAck"])
        state, _, mode = ADAPTER.classify(evidence, "head-7", None, START + 240)
        self.assertEqual(state, "trigger-incremental")
        self.assertEqual(mode, "incremental")

    def test_check_suite_creation_bounds_ack_when_activity_is_unavailable(
        self,
    ) -> None:
        gh = configured_gh(
            comments=self.ack_before_push(),
            pushed=None,
            check_suites_created=[START + 260, START + 200],
        )
        evidence = ADAPTER.pull_evidence(gh, "owner/repo", 7)
        self.assertEqual(evidence["headPushedAt"], iso(START + 200))
        self.assertEqual(evidence["headPushSource"], "check-suite")
        state, _, _ = ADAPTER.classify(evidence, "head-7", None, START + 240)
        self.assertNotEqual(state, "clean-complete")

    def test_unknown_push_time_requires_head_scoped_check_for_clean_complete(
        self,
    ) -> None:
        gh = configured_gh(comments=self.ack_before_push(), pushed=None)
        evidence = ADAPTER.pull_evidence(gh, "owner/repo", 7)
        self.assertIsNone(evidence["headPushedAt"])
        state, reason, mode = ADAPTER.classify(evidence, "head-7", None, START + 240)
        self.assertEqual(state, "pending-check-required")
        self.assertIn("push time is unknown", reason)
        self.assertIsNone(mode)

        gh = configured_gh(
            comments=self.ack_before_push(),
            pushed=None,
            coderabbit_check_runs=[
                {
                    "name": "CodeRabbit",
                    "head_sha": "head-7",
                    "status": "completed",
                    "conclusion": "success",
                }
            ],
        )
        state, reason, _ = classify(gh)
        self.assertEqual(state, "clean-complete")
        self.assertIn("CodeRabbit check SUCCESS", reason)

    def test_activity_lookup_failure_falls_back_but_rate_limits_propagate(
        self,
    ) -> None:
        activity = "repos/owner/repo/activity?ref=refs/heads/feature&per_page=100"

        def failing(error: Exception) -> FakeGh:
            gh = configured_gh(
                comments=self.ack_before_push(),
                check_suites_created=[START + 200],
            )
            original = gh.rest_pages

            def rest_pages(endpoint: str) -> list[Any]:
                if endpoint == activity:
                    raise error
                return original(endpoint)

            gh.rest_pages = rest_pages  # type: ignore[method-assign]
            return gh

        evidence = ADAPTER.pull_evidence(
            failing(ADAPTER.WaitError("gh: Not Found (HTTP 404)")), "owner/repo", 7
        )
        self.assertEqual(evidence["headPushSource"], "check-suite")
        with self.assertRaises(ADAPTER.RateLimited):
            ADAPTER.pull_evidence(
                failing(ADAPTER.RateLimited("rate limit")), "owner/repo", 7
            )
        with self.assertRaises(ADAPTER.WaitError):
            ADAPTER.pull_evidence(
                failing(ADAPTER.WaitError("gh: Server Error (HTTP 500)")), "owner/repo", 7
            )

    def test_check_suite_from_another_branch_does_not_bound_the_push(self) -> None:
        # The commit reached another branch at START + 50, before CodeRabbit
        # finished the previous PR head; its suite says nothing about this push.
        gh = configured_gh(
            comments=self.ack_before_push(),
            pushed=None,
            check_suites_created=[START + 50],
            check_suite_branch="scratch",
        )
        evidence = ADAPTER.pull_evidence(gh, "owner/repo", 7)
        self.assertIsNone(evidence["headPushedAt"])
        state, _, _ = ADAPTER.classify(evidence, "head-7", None, START + 240)
        self.assertEqual(state, "pending-check-required")

    def test_run_returns_pending_check_required_without_waiting_or_triggering(
        self,
    ) -> None:
        gh = configured_gh(comments=self.ack_before_push(), pushed=None)
        clock = [float(START + 240)]

        def sleep(seconds: float) -> None:
            clock[0] += seconds

        state, reason, _ = ADAPTER.run_review(
            gh,
            "owner/repo",
            7,
            "head-7",
            ["owner/repo"],
            START + 900,
            10,
            clock=lambda: clock[0],
            sleeper=sleep,
        )
        self.assertEqual(state, "pending")
        self.assertIn("push time is unknown", reason)
        self.assertEqual(clock[0], START + 240)
        self.assertEqual(gh.posts, [])

    def test_coderabbit_check_run_success_binds_exact_head(self) -> None:
        comments = [
            comment(10, "@coderabbitai full review", START + 60, bot=False),
            comment(11, "Review finished", START + 65),
            comment(
                12,
                "<!-- summarize by coderabbit --> src/feature.ts",
                START + 66,
            ),
        ]
        gh = configured_gh(
            comments=comments,
            coderabbit_check_runs=[
                {
                    "name": "CodeRabbit",
                    "head_sha": "head-7",
                    "status": "completed",
                    "conclusion": "success",
                }
            ],
        )
        state, _, mode = classify(gh)
        self.assertEqual(state, "clean-complete")
        self.assertIsNone(mode)

    def test_check_run_success_with_rate_limited_output_is_not_check_success(
        self,
    ) -> None:
        comments = [
            comment(10, "@coderabbitai full review", START + 60, bot=False),
            comment(11, "Review finished", START + 65),
            comment(
                12,
                "<!-- summarize by coderabbit --> src/feature.ts",
                START + 66,
            ),
        ]
        gh = configured_gh(
            comments=comments,
            coderabbit_check_runs=[
                {
                    "name": "CodeRabbit",
                    "head_sha": "head-7",
                    "status": "completed",
                    "conclusion": "success",
                    "output": {
                        "title": "Review rate limited",
                        "summary": "Review rate limited",
                        "text": "Action not completed: review rate limited",
                    },
                }
            ],
        )
        evidence = ADAPTER.pull_evidence(gh, "owner/repo", 7)
        self.assertFalse(evidence["codeRabbitCheckSuccess"])
        self.assertEqual(evidence["codeRabbitCheck"]["state"], "RATE_LIMITED")
        self.assertTrue(evidence["rateLimited"])
        state, reason, mode = classify(gh)
        self.assertNotEqual(state, "clean-complete")
        self.assertEqual(state, "pending-retry-source")
        self.assertIn("rate limited", reason)
        self.assertIsNone(mode)

    def test_commit_status_success_with_rate_limited_description_is_not_check_success(
        self,
    ) -> None:
        gh = configured_gh(
            coderabbit_statuses=[
                {
                    "context": "CodeRabbit",
                    "state": "success",
                    "description": "Review rate limited",
                    "created_at": iso(START + 64),
                }
            ],
        )
        evidence = ADAPTER.pull_evidence(gh, "owner/repo", 7)
        self.assertFalse(evidence["codeRabbitCheckSuccess"])
        self.assertEqual(evidence["codeRabbitCheck"]["state"], "RATE_LIMITED")
        self.assertTrue(evidence["codeRabbitCheck"].get("rateLimited"))
        self.assertTrue(evidence["rateLimited"])

    def test_comment_rate_limit_blocks_clean_complete_despite_success_check(
        self,
    ) -> None:
        comments = [
            comment(10, "@coderabbitai full review", START + 60, bot=False),
            comment(11, "Review finished", START + 65),
            comment(
                12,
                "<!-- summarize by coderabbit --> src/feature.ts",
                START + 66,
            ),
            comment(13, "Action not completed: review rate limited", START + 70),
        ]
        gh = configured_gh(
            comments=comments,
            coderabbit_check_runs=[
                {
                    "name": "CodeRabbit",
                    "head_sha": "head-7",
                    "status": "completed",
                    "conclusion": "success",
                }
            ],
        )
        evidence = ADAPTER.pull_evidence(gh, "owner/repo", 7)
        self.assertTrue(evidence["codeRabbitCheckSuccess"])
        self.assertTrue(evidence["rateLimited"])
        state, reason, mode = ADAPTER.classify(
            evidence, "head-7", None, START + 180
        )
        self.assertEqual(state, "pending-retry-source")
        self.assertIn("rate limited", reason)
        self.assertIsNone(mode)
        self.assertNotEqual(state, "clean-complete")


NOW = START + 180
HOUR = 3600


def availability(remaining: int, per_hour: int) -> str:
    reviews = "review remains" if remaining == 1 else "reviews remain"
    return (
        "**Included review availability:** This review used your included "
        f"allowance. {remaining} included {reviews} after this review. Your "
        "included PR review attempts over the past 7 days set your current "
        f"allowance at {per_hour} reviews per hour."
    )


def summary_comment(
    identifier: int,
    pr: int,
    updated: int,
    statement: str,
    run_id: str | None,
) -> dict[str, Any]:
    run = f"**Run ID**: `{run_id}`\n\n" if run_id else ""
    return comment(
        identifier,
        "<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n"
        f"{run}{statement}",
        updated - 900,
        updated=updated,
        issue_url=f"https://api.github.test/repos/owner/repo/issues/{pr}",
    )


def run_review_object(
    identifier: int, run_id: str, submitted: int, body: str = "Actionable comments posted: 1"
) -> dict[str, Any]:
    return {
        "id": identifier,
        "user": {"login": "coderabbitai[bot]"},
        "body": f"{body}\n\n**Run ID**: `{run_id}`",
        "state": "COMMENTED",
        "commit_id": "other-head",
        "submitted_at": iso(submitted),
    }


def budget_gh(
    account_comments: list[dict[str, Any]],
    *,
    now: int = NOW,
    pr_comments: list[dict[str, Any]] | None = None,
    other_reviews: dict[int, list[dict[str, Any]]] | None = None,
    wait_comments: list[dict[str, Any]] | None = None,
) -> FakeGh:
    gh = configured_gh(comments=pr_comments)
    scan = (
        "repos/owner/repo/issues/comments?sort=updated&direction=desc"
        f"&per_page=100&since={iso(now - 2 * HOUR)}"
    )
    gh.pages[scan] = [account_comments]
    for pr, reviews in (other_reviews or {}).items():
        gh.pages[f"repos/owner/repo/pulls/{pr}/reviews?per_page=100"] = [reviews]
    if wait_comments:
        gh.pages[
            "repos/owner/repo/issues/comments?sort=updated&direction=desc&per_page=100"
        ] = [wait_comments]
    return gh


def observe(gh: FakeGh, now: int = NOW) -> dict[str, Any]:
    return ADAPTER.observation(
        gh, "owner/repo", [7], {7: "head-7"}, ["owner/repo"], now
    )


class CodeRabbitAllowanceBudgetTest(unittest.TestCase):
    def test_statement_parsing_handles_singular_plural_and_zero(self) -> None:
        cases = {
            availability(1, 2): 1,
            availability(2, 5): 2,
            availability(0, 2): 0,
            "**Included review availability:** 1 review is currently available. "
            "Your included PR review attempts over the past 7 days set your "
            "current allowance at 10 reviews per hour.": 1,
            "**Included review availability:** 7 reviews are currently available. "
            "Your included PR review attempts over the past 7 days set your "
            "current allowance at 8 reviews per hour.": 7,
            "**Limit details:** You’ve used all 2 included reviews currently "
            "available. Your 84 included PR review attempts over the past 7 days "
            "set your current allowance at 2 reviews per hour.": 0,
        }
        for text, remaining in cases.items():
            with self.subTest(text=text):
                parsed = ADAPTER.parse_allowance(text)
                assert parsed
                self.assertEqual(parsed["remaining"], remaining)
                self.assertEqual(parsed["windowSeconds"], HOUR)
        self.assertEqual(ADAPTER.parse_allowance(availability(1, 2))["allowance"], 2)
        self.assertEqual(
            ADAPTER.parse_allowance(
                "set your current allowance at 1 review per hour."
            )["allowance"],
            1,
        )
        self.assertIsNone(ADAPTER.parse_allowance("Review finished"))
        self.assertIsNone(ADAPTER.parse_allowance("1 included review remains after this review."))

    def test_used_up_allowance_waits_until_the_oldest_attempt_leaves_the_window(
        self,
    ) -> None:
        gh = budget_gh(
            [
                summary_comment(81, 8, NOW - 1800, availability(1, 2), "run-a"),
                summary_comment(91, 9, NOW - 600, availability(0, 2), "run-b"),
            ]
        )
        value = observe(gh)
        item = value["pullRequests"][0]
        self.assertEqual(item["state"], "waiting")
        self.assertEqual(item["nextMode"], "incremental")
        self.assertEqual(item["retryAt"], iso(NOW - 1800 + HOUR + 60))
        self.assertEqual(item["retrySource"], "allowance")
        allowance = value["allowance"]
        self.assertEqual(allowance["mode"], "enforced")
        self.assertTrue(allowance["exhausted"])
        self.assertEqual(allowance["remaining"], 0)
        self.assertEqual(allowance["perHour"], 2)
        self.assertEqual(allowance["statementAt"], iso(NOW - 600))
        self.assertEqual(
            allowance["source"], {"repo": "owner/repo", "pr": 9, "commentId": 91}
        )
        self.assertEqual(allowance["attempts"]["count"], 2)
        self.assertEqual(allowance["retryAt"], iso(NOW - 1800 + HOUR + 60))

    def test_review_objects_count_once_per_run_across_pull_requests(self) -> None:
        # Run c's summary was overwritten by run a; its review object remains.
        # Run b appears as both a review object and a summary statement.
        gh = budget_gh(
            [
                summary_comment(81, 8, NOW - 1800, availability(1, 2), "run-a"),
                summary_comment(91, 9, NOW - 600, availability(0, 2), "run-b"),
            ],
            other_reviews={
                8: [run_review_object(801, "run-c", NOW - 3000)],
                9: [
                    run_review_object(901, "run-b", NOW - 700),
                    {**run_review_object(902, "run-x", NOW - 650), "body": ""},
                ],
            },
        )
        value = observe(gh)
        allowance = value["allowance"]
        self.assertEqual(allowance["attempts"]["count"], 3)
        self.assertTrue(allowance["exhausted"])
        # Three attempts against two per hour: two must leave the window.
        self.assertEqual(allowance["retryAt"], iso(NOW - 1800 + HOUR + 60))
        self.assertEqual(value["pullRequests"][0]["state"], "waiting")

    def test_statement_binds_the_run_id_of_its_own_review(self) -> None:
        # A skip notice above the recent-review block carries the skipped run's
        # ID; only the run the statement describes is counted.
        skipped_then_reviewed = comment(
            81,
            "<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n"
            "> ## Review skipped\n> **Run ID**: `run-skip`\n"
            "<!-- recent_review_start -->\n**Run ID**: `run-a`\n\n"
            + availability(1, 2),
            NOW - 1500,
            updated=NOW - 600,
            issue_url="https://api.github.test/repos/owner/repo/issues/8",
        )
        allowance = observe(budget_gh([skipped_then_reviewed]))["allowance"]
        self.assertEqual(
            [run["runId"] for run in allowance["attempts"]["runs"]], ["run-a"]
        )

    def test_newest_statement_outranks_a_higher_window_count(self) -> None:
        # Counted times can trail a run's start, so a window count above the
        # allowance does not override CodeRabbit's own "1 remains".
        gh = budget_gh(
            [
                comment(
                    81,
                    "Review finished",
                    NOW - 1700,
                    issue_url="https://api.github.test/repos/owner/repo/issues/8",
                ),
                summary_comment(91, 9, NOW - 600, availability(1, 2), "run-b"),
            ],
            other_reviews={
                8: [
                    run_review_object(801, "run-c", NOW - 3000),
                    run_review_object(802, "run-a", NOW - 1800),
                ],
                9: [run_review_object(901, "run-b", NOW - 700)],
            },
        )
        value = observe(gh)
        self.assertEqual(value["allowance"]["attempts"]["count"], 3)
        self.assertFalse(value["allowance"]["exhausted"])
        self.assertEqual(value["pullRequests"][0]["state"], "trigger-incremental")

    def test_runs_after_the_statement_use_up_its_remaining_reviews(self) -> None:
        gh = budget_gh(
            [summary_comment(91, 9, NOW - 900, availability(1, 2), "run-b")],
            other_reviews={
                8: [run_review_object(801, "run-a", NOW - 2400)],
                9: [run_review_object(902, "run-d", NOW - 120)],
            },
        )
        value = observe(gh)
        self.assertTrue(value["allowance"]["exhausted"])
        self.assertEqual(value["allowance"]["retryAt"], iso(NOW - 900 + HOUR + 60))
        self.assertEqual(value["pullRequests"][0]["state"], "waiting")

    def test_available_allowance_permits_the_trigger(self) -> None:
        gh = budget_gh(
            [summary_comment(81, 8, NOW - 600, availability(1, 2), "run-a")]
        )
        value = observe(gh)
        item = value["pullRequests"][0]
        self.assertEqual(item["state"], "trigger-incremental")
        self.assertIsNone(item["retryAt"])
        allowance = value["allowance"]
        self.assertEqual(allowance["mode"], "enforced")
        self.assertFalse(allowance["exhausted"])
        self.assertEqual(allowance["remaining"], 1)
        self.assertEqual(allowance["attempts"]["count"], 1)
        self.assertIsNone(allowance["retryAt"])

    def test_exhaustion_ends_when_its_oldest_attempt_leaves_the_window(
        self,
    ) -> None:
        gh = budget_gh(
            [summary_comment(81, 8, NOW - 3000, availability(0, 2), "run-a")],
            other_reviews={8: [run_review_object(801, "run-c", NOW - 3700)]},
        )
        value = observe(gh)
        self.assertEqual(value["pullRequests"][0]["state"], "trigger-incremental")
        self.assertEqual(value["allowance"]["mode"], "enforced")
        self.assertFalse(value["allowance"]["exhausted"])
        self.assertEqual(value["allowance"]["attempts"]["count"], 1)

    def test_later_stated_wait_takes_precedence_over_the_allowance(self) -> None:
        exhausted = [
            summary_comment(81, 8, NOW - 1800, availability(1, 2), "run-a"),
            summary_comment(91, 9, NOW - 600, availability(0, 2), "run-b"),
        ]
        later = budget_gh(
            exhausted,
            wait_comments=[
                comment(95, "Next review available in: 40 minutes", NOW - 60)
            ],
        )
        item = observe(later)["pullRequests"][0]
        self.assertEqual(item["state"], "waiting")
        self.assertEqual(item["retryAt"], iso(NOW - 60 + 2400 + 60))
        self.assertEqual(item["retrySource"], "stated-wait")

        earlier = budget_gh(
            exhausted,
            wait_comments=[
                comment(95, "Next review available in: 5 minutes", NOW - 60)
            ],
        )
        item = observe(earlier)["pullRequests"][0]
        self.assertEqual(item["retryAt"], iso(NOW - 1800 + HOUR + 60))
        self.assertEqual(item["retrySource"], "allowance")

    def test_statement_older_than_its_window_is_ignored(self) -> None:
        gh = budget_gh(
            [summary_comment(81, 8, NOW - HOUR - 100, availability(0, 2), "run-a")]
        )
        value = observe(gh)
        self.assertEqual(value["pullRequests"][0]["state"], "trigger-incremental")
        allowance = value["allowance"]
        self.assertEqual(allowance["mode"], "degraded")
        self.assertIsNone(allowance["remaining"])
        self.assertIsNone(allowance["retryAt"])
        self.assertIn("no allowance statement", allowance["reason"])

    def test_missing_attempt_evidence_degrades_to_stated_waits(self) -> None:
        gh = budget_gh(
            [summary_comment(81, 8, NOW - 600, availability(0, 2), None)]
        )
        value = observe(gh)
        self.assertEqual(value["pullRequests"][0]["state"], "trigger-incremental")
        allowance = value["allowance"]
        self.assertEqual(allowance["mode"], "degraded")
        self.assertEqual(allowance["remaining"], 0)
        self.assertEqual(allowance["attempts"]["count"], 0)
        self.assertFalse(allowance["exhausted"])
        self.assertIsNone(allowance["retryAt"])
        self.assertIn("stated waits", allowance["reason"])

    def rate_limited_pr(self) -> list[dict[str, Any]]:
        return [
            comment(10, "@coderabbitai review", START + 60, bot=False),
            comment(11, "Action not completed: review rate limited", START + 90),
        ]

    def test_rate_limit_without_stated_wait_uses_the_derived_retry(self) -> None:
        account = [
            summary_comment(81, 8, START - 1200, availability(1, 2), "run-a"),
            summary_comment(91, 9, START + 50, availability(0, 2), "run-b"),
        ]
        gh = budget_gh(account, pr_comments=self.rate_limited_pr())
        item = observe(gh)["pullRequests"][0]
        self.assertEqual(item["state"], "waiting")
        self.assertEqual(item["nextMode"], "incremental")
        self.assertEqual(item["retryAt"], iso(START - 1200 + HOUR + 60))
        self.assertEqual(item["retrySource"], "allowance")

        later = START + 2500
        gh = budget_gh(account, pr_comments=self.rate_limited_pr(), now=later)
        item = observe(gh, later)["pullRequests"][0]
        self.assertEqual(item["state"], "trigger-incremental")

    def test_rate_limit_without_attempts_before_it_keeps_pending_retry_source(
        self,
    ) -> None:
        # The only counted run follows the notice, so it cannot explain it.
        gh = budget_gh(
            [summary_comment(81, 8, START + 150, availability(1, 2), "run-a")],
            pr_comments=self.rate_limited_pr(),
        )
        item = observe(gh)["pullRequests"][0]
        self.assertEqual(item["state"], "pending-retry-source")
        self.assertIsNone(item["retryAt"])

    def test_run_never_posts_while_the_allowance_is_used_up(self) -> None:
        gh = budget_gh(
            [
                summary_comment(81, 8, NOW - 1800, availability(1, 2), "run-a"),
                summary_comment(91, 9, NOW - 600, availability(0, 2), "run-b"),
            ]
        )
        sleeps: list[float] = []
        state, reason, evidence = ADAPTER.run_review(
            gh,
            "owner/repo",
            7,
            "head-7",
            ["owner/repo"],
            NOW,
            10,
            clock=lambda: float(NOW),
            sleeper=sleeps.append,
        )
        self.assertEqual(state, "pending")
        self.assertIn("before trustworthy review completion", reason)
        self.assertEqual(gh.posts, [])
        self.assertEqual(evidence["pullRequests"][0]["state"], "waiting")


if __name__ == "__main__":
    unittest.main()
