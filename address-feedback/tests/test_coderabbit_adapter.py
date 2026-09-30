#!/usr/bin/env python3
"""Behavioral tests for the CodeRabbit adapter, replayed from recorded GitHub evidence."""

from __future__ import annotations

import copy
import importlib.util
import json
import re
import tempfile
import unittest
from pathlib import Path
from typing import Any, Callable
from unittest import mock
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "address-feedback" / "scripts" / "coderabbit_adapter.py"
SPEC = importlib.util.spec_from_file_location("coderabbit_adapter", MODULE_PATH)
assert SPEC and SPEC.loader
ADAPTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ADAPTER)

FIXTURE = json.loads(
    (Path(__file__).resolve().parent / "fixtures" / "coderabbit_recorded.json").read_text()
)
REPO = FIXTURE["repo"]
NEIGHBOURS = [str(pr) for pr in range(1044, 1056)]


def at(value: str) -> float:
    return ADAPTER.parse_time(value)


def iso(value: float) -> str:
    return ADAPTER.format_timestamp(value)


class FakeMetrics:
    def __init__(self) -> None:
        self.retries = 0


class Replay:
    """GitHub as the recorded cases showed it at `now`.

    Serves the REST and GraphQL reads the adapter makes; POSTs are recorded.
    """

    def __init__(self, *prs: str, now: str) -> None:
        self.cases = {pr: copy.deepcopy(FIXTURE["cases"][pr]) for pr in prs}
        self.now = at(now)
        self.metrics = FakeMetrics()
        self.posts: list[tuple[str, dict[str, str], float]] = []
        self.on_post: Callable[[str, dict[str, str]], None] | None = None
        self.requests: list[str] = []
        self.closed: set[str] = set()
        self.next_id = 9_000_000_000

    # Mutations of the recorded evidence -------------------------------------

    def case(self, pr: str) -> dict[str, Any]:
        return self.cases[pr]

    def comment(self, pr: str, identifier: int) -> dict[str, Any]:
        return next(item for item in self.cases[pr]["comments"] if item["id"] == identifier)

    def move_version(self, pr: str, identifier: int, old: str, new: str) -> None:
        versions = self.comment(pr, identifier)["versions"]
        index = next(i for i, (edited, _body) in enumerate(versions) if edited == old)
        versions[index][0] = new
        versions.sort()
        self.comment(pr, identifier)["created_at"] = versions[0][0]

    def add_status(self, pr: str, description: str, when: str, state: str = "success") -> None:
        case = self.cases[pr]
        self.next_id += 1
        case["statuses"][case["head"]].append(
            {
                "id": self.next_id,
                "state": state,
                "description": description,
                "context": "CodeRabbit",
                "created_at": when,
                "creator": {"login": "coderabbitai[bot]"},
            }
        )

    def add_comment(self, pr: str, body: str, when: str, login: str = "maintainer") -> int:
        self.next_id += 1
        self.cases[pr]["comments"].append(
            {
                "id": self.next_id,
                "user": {"login": login},
                "html_url": f"https://github.com/{REPO}/pull/{pr}#issuecomment-{self.next_id}",
                "created_at": when,
                "versions": [[when, body]],
            }
        )
        return self.next_id

    # GitHub reads ------------------------------------------------------------

    def by_number(self, number: int) -> dict[str, Any] | None:
        return self.cases.get(str(number))

    def visible_comments(self, pr: str) -> list[dict[str, Any]]:
        shown = []
        for item in self.cases[pr]["comments"]:
            versions = [version for version in item["versions"] if at(version[0]) <= self.now]
            if not versions:
                continue
            shown.append(
                {
                    "id": item["id"],
                    "node_id": f"IC_{item['id']}",
                    "user": item["user"],
                    "html_url": item["html_url"],
                    "issue_url": f"https://api.github.com/repos/{REPO}/issues/{pr}",
                    "created_at": item["created_at"],
                    "updated_at": versions[-1][0],
                    "body": versions[-1][1],
                }
            )
        return shown

    def statuses(self, sha: str) -> list[dict[str, Any]]:
        for case in self.cases.values():
            if sha in case["statuses"]:
                shown = [item for item in case["statuses"][sha] if at(item["created_at"]) <= self.now]
                return sorted(shown, key=lambda item: (item["created_at"], item["id"]), reverse=True)
        return []

    def rest(self, endpoint: str, method: str = "GET", fields: dict[str, str] | None = None) -> Any:
        if method == "POST":
            self.posts.append((endpoint, dict(fields or {}), self.now))
            if self.on_post:
                self.on_post(endpoint, dict(fields or {}))
            self.next_id += 1
            return {"id": self.next_id}
        self.requests.append(endpoint)
        match = re.fullmatch(r"repos/[^/]+/[^/]+/pulls/(\d+)", endpoint)
        if match and self.by_number(int(match.group(1))):
            pr = match.group(1)
            case = self.cases[pr]
            draft = case["draft"] or bool(case["draftUntil"] and self.now < at(case["draftUntil"]))
            return {
                "head": {"sha": case["head"], "ref": case["ref"]},
                "state": "closed" if pr in self.closed else "open",
                "draft": draft,
            }
        raise ADAPTER.WaitError(f"gh: Not Found (HTTP 404) {endpoint}")

    def rest_pages(self, endpoint: str) -> list[Any]:
        self.requests.append(endpoint)
        path = urlparse(endpoint).path
        query = parse_qs(urlparse(endpoint).query)
        match = re.fullmatch(r"repos/[^/]+/[^/]+/commits/([0-9a-f]+)/statuses", path)
        if match:
            return [self.statuses(match.group(1))]
        match = re.fullmatch(r"repos/[^/]+/[^/]+/commits/([0-9a-f]+)/check-suites", path)
        if match:
            for case in self.cases.values():
                if match.group(1) in case["checkSuites"]:
                    suites = [
                        suite
                        for suite in case["checkSuites"][match.group(1)]
                        if at(suite["created_at"]) <= self.now
                    ]
                    return [{"check_suites": suites}]
            return [{"check_suites": []}]
        match = re.fullmatch(r"repos/[^/]+/[^/]+/issues/(\d+)/comments", path)
        if match:
            return [self.visible_comments(match.group(1))]
        match = re.fullmatch(r"repos/[^/]+/[^/]+/pulls/(\d+)/reviews", path)
        if match:
            case = self.cases[match.group(1)]
            return [[item for item in case["reviews"] if at(item["submitted_at"]) <= self.now]]
        if path.endswith("/issues/comments"):
            since = at(query["since"][0])
            found = [
                item
                for pr in self.cases
                for item in self.visible_comments(pr)
                if at(item["updated_at"]) >= since
            ]
            return [sorted(found, key=lambda item: item["updated_at"], reverse=True)]
        raise AssertionError(f"unexpected read {endpoint}")

    def graphql(self, query: str, variables: dict[str, Any]) -> dict[str, Any]:
        if "userContentEdits" in query:
            self.requests.append(f"graphql:{variables['id']}")
            identifier = int(variables["id"].removeprefix("IC_"))
            item = next(
                entry
                for case in self.cases.values()
                for entry in case["comments"]
                if entry["id"] == identifier
            )
            versions = [version for version in item["versions"] if at(version[0]) <= self.now]
            nodes = [{"editedAt": edited, "diff": body} for edited, body in reversed(versions)]
            if len(nodes) < 2:
                nodes = []  # GitHub lists no edits for an unedited comment.
            start = int(variables.get("cursor") or 0)
            return {
                "node": {
                    "userContentEdits": {
                        "pageInfo": {"hasNextPage": start + 20 < len(nodes), "endCursor": str(start + 20)},
                        "nodes": nodes[start:start + 20],
                    }
                }
            }
        self.requests.append(f"graphql:commits:{variables['number']}")
        case = self.by_number(int(variables["number"]))
        nodes = []
        for sha in (case or {}).get("statuses", {}):
            shown = sorted(self.statuses(sha), key=lambda item: item["created_at"])
            latest: dict[str, str] = {}
            for item in shown:
                latest[item["context"]] = item["created_at"]
            nodes.append(
                {
                    "commit": {
                        "oid": sha,
                        "status": {"contexts": [{"context": name, "createdAt": when} for name, when in latest.items()]}
                        if latest
                        else None,
                    }
                }
            )
        return {"repository": {"pullRequest": {"commits": {"nodes": nodes}}}}


def observe(gh: Replay, pr: str, head: str | None = None) -> dict[str, Any]:
    expected = head or gh.cases[pr]["head"]
    value = ADAPTER.observation(gh, REPO, [int(pr)], {int(pr): expected}, [REPO], gh.now)
    return value["pullRequests"][0] | {"accountWait": value["accountWait"]}


def state(pr: str, now: str, *others: str) -> dict[str, Any]:
    return observe(Replay(pr, *others, now=now), pr)


def run(gh: Replay, pr: str, deadline: str, interval: float = 60) -> tuple[str, str, dict[str, Any]]:
    sleeps = [0]

    def sleep(seconds: float) -> None:
        sleeps[0] += 1
        if sleeps[0] > 1000:
            raise AssertionError("run_review kept polling without the clock reaching the deadline")
        gh.now += seconds

    return ADAPTER.run_review(
        gh,
        REPO,
        int(pr),
        gh.cases[pr]["head"],
        [REPO],
        at(deadline),
        interval,
        clock=lambda: gh.now,
        sleeper=sleep,
    )


class HeadStatusTest(unittest.TestCase):
    """Each CodeRabbit status on the head, as recorded, reaches its state."""

    def test_no_status_on_a_ready_head_triggers_an_incremental_review(self) -> None:
        gh = Replay("1043", now="2026-09-30T16:17:05Z")
        gh.case("1043")["draftUntil"] = None
        result = observe(gh, "1043")
        self.assertIsNone(result["status"])
        self.assertEqual((result["state"], result["nextMode"]), ("trigger-incremental", "incremental"))

    def test_draft_skip_on_a_draft_waits_for_it_to_be_ready(self) -> None:
        result = state("1043", "2026-09-30T16:30:00Z")
        self.assertEqual(result["status"]["description"], "Review skipped: draft pull request")
        self.assertEqual(result["state"], "draft")
        self.assertIsNone(result["nextMode"])

    def test_draft_skip_after_the_pr_is_ready_triggers_an_incremental_review(self) -> None:
        result = state("1043", "2026-09-30T17:02:15Z")
        self.assertFalse(result["draft"])
        self.assertEqual(result["status"]["kind"], "draft-skip")
        self.assertEqual(result["state"], "trigger-incremental")

    def test_review_in_progress_is_waited_on(self) -> None:
        result = state("1095", "2026-09-30T19:12:00Z")
        self.assertEqual(result["status"]["description"], "Review in progress")
        self.assertEqual(result["state"], "in-progress")
        self.assertIsNone(result["nextMode"])

    def test_rate_limit_waits_for_the_stated_wait_edited_in_before_it(self) -> None:
        result = state("1043", "2026-09-30T17:05:00Z")
        self.assertEqual(result["status"]["description"], "Review rate limited")
        self.assertEqual(result["state"], "waiting")
        self.assertEqual(result["rateLimit"]["wait"]["editedAt"], "2026-09-30T17:02:28Z")
        self.assertEqual(result["rateLimit"]["wait"]["statedSeconds"], 12 * 60)
        self.assertEqual(result["rateLimit"]["wait"]["availableAt"], "2026-09-30T17:14:28Z")
        self.assertEqual(result["retryAt"], "2026-09-30T17:15:28Z")
        self.assertEqual(result["nextMode"], "incremental")

    def test_file_limit_skip_is_terminal(self) -> None:
        result = state("1018", "2026-09-29T11:04:00Z")
        self.assertEqual(result["state"], "skipped")
        self.assertIn("474 files exceed the limit of 150", result["reason"])

    def test_bot_user_skip_is_terminal(self) -> None:
        result = state("1089", "2026-09-30T12:15:00Z")
        self.assertEqual(result["state"], "skipped")
        self.assertIn("bot user not eligible for review", result["reason"])

    def test_bare_skip_is_terminal(self) -> None:
        result = state("1069", "2026-09-29T20:10:50Z")
        self.assertEqual((result["state"], result["status"]["description"]), ("skipped", "Review skipped"))

    def test_findings_review_of_the_head_completes_it(self) -> None:
        result = state("1040", "2026-09-30T01:43:00Z")
        self.assertEqual(result["status"]["description"], "Review completed")
        self.assertEqual(result["state"], "review-complete")
        self.assertEqual(result["findingsReview"]["actionable"], 1)

    def test_coverage_marker_for_the_head_completes_a_clean_pass(self) -> None:
        for pr, now in (("1087", "2026-09-30T10:26:00Z"), ("1095", "2026-09-30T19:18:00Z")):
            with self.subTest(pr=pr):
                result = state(pr, now)
                self.assertEqual(result["state"], "clean-complete")
                self.assertEqual(result["cleanReview"]["coveredCommitId"], FIXTURE["cases"][pr]["head"])

    def test_completed_status_without_review_or_marker_escalates_to_one_full_review(self) -> None:
        result = state("1089", "2026-09-30T13:20:00Z")
        self.assertIsNone(result["findingsReview"])
        self.assertIsNone(result["cleanReview"])
        self.assertEqual((result["state"], result["nextMode"]), ("trigger-full", "full"))

    def test_unrecognized_status_is_terminal(self) -> None:
        gh = Replay("1043", now="2026-09-30T17:20:00Z")
        gh.add_status("1043", "Review failed", "2026-09-30T17:19:00Z", state="error")
        self.assertEqual(observe(gh, "1043")["state"], "unrecognized-status")

    def test_closed_pull_request_is_terminal(self) -> None:
        gh = Replay("1083", now="2026-09-30T08:30:00Z")
        gh.closed.add("1083")
        self.assertEqual(observe(gh, "1083")["state"], "closed")

    def test_only_coderabbits_own_statuses_decide(self) -> None:
        gh = Replay("1043", now="2026-09-30T17:05:00Z")
        case = gh.case("1043")
        case["statuses"][case["head"]].append(
            {
                "id": 1,
                "state": "success",
                "description": "Review completed",
                "context": "CodeRabbit",
                "created_at": "2026-09-30T17:04:00Z",
                "creator": {"login": "maintainer"},
            }
        )
        self.assertEqual(observe(gh, "1043")["status"]["description"], "Review rate limited")


class HeadScopeTest(unittest.TestCase):
    """Evidence about another head never completes the current one."""

    def test_a_changed_head_invalidates(self) -> None:
        result = observe(Replay("1043", now="2026-09-30T17:05:00Z"), "1043", head="0" * 40)
        self.assertEqual(result["state"], "invalidated")

    def test_the_previous_heads_review_and_marker_do_not_complete_the_new_head(self) -> None:
        gh = Replay("1059", now="2026-09-29T18:10:00Z")
        previous = "5cfbbb4440bad75300ed6aff3c1e15139cfdde26"
        summary = gh.visible_comments("1059")[0]["body"]
        self.assertIn(f'"coveredCommitId":"{previous}"', summary)
        self.assertTrue(any(review["commit_id"] == previous for review in gh.case("1059")["reviews"]))
        result = observe(gh, "1059")
        self.assertIsNone(result["findingsReview"])
        self.assertIsNone(result["cleanReview"])
        self.assertEqual(result["state"], "waiting")
        gh.add_status("1059", "Review completed", "2026-09-29T18:40:00Z")
        gh.now = at("2026-09-29T18:41:00Z")
        self.assertEqual(observe(gh, "1059")["state"], "trigger-full")

    def test_a_clean_marker_naming_the_previous_head_does_not_complete(self) -> None:
        gh = Replay("1083", now="2026-09-30T07:45:00Z")
        summary = next(item["body"] for item in gh.visible_comments("1083") if item["id"] == 5903148452)
        self.assertIn('"coveredCommitId":"3e873ee6', summary)
        self.assertIn(ADAPTER.NO_ACTIONABLE, summary)
        result = observe(gh, "1083")
        self.assertIsNone(result["cleanReview"])
        self.assertEqual(result["state"], "waiting")
        self.assertEqual(result["rateLimit"]["wait"]["editedAt"], "2026-09-30T07:29:16Z")

    def test_a_trigger_reply_edited_into_finished_after_a_push_does_not_complete(self) -> None:
        gh = Replay("1083", now="2026-09-30T07:45:00Z")
        gh.move_version("1083", 5904186005, "2026-09-30T04:44:16Z", "2026-09-30T07:40:00Z")
        reply = next(item for item in gh.visible_comments("1083") if item["id"] == 5904186005)
        self.assertIn("Full review finished.", reply["body"])
        self.assertGreater(at(reply["updated_at"]), at(observe(gh, "1083")["headArrival"]["at"]))
        result = observe(gh, "1083")
        self.assertNotIn(result["state"], ADAPTER.COMPLETE_STATES)
        self.assertEqual(result["state"], "waiting")

    def test_a_findings_review_counts_only_for_its_own_commit(self) -> None:
        gh = Replay("1040", now="2026-09-30T01:43:00Z")
        for review in gh.case("1040")["reviews"]:
            review["commit_id"] = "0" * 40
        result = observe(gh, "1040")
        self.assertIsNone(result["findingsReview"])
        self.assertEqual(result["state"], "trigger-full")

    def test_a_marker_counts_only_for_its_own_commit(self) -> None:
        gh = Replay("1087", now="2026-09-30T10:26:00Z")
        summary = gh.comment("1087", 5907716986)
        head = gh.case("1087")["head"]
        summary["versions"][-1][1] = summary["versions"][-1][1].replace(
            f'"coveredCommitId":"{head}"', f'"coveredCommitId":"{"0" * 40}"'
        )
        self.assertEqual(observe(gh, "1087")["state"], "trigger-full")


class StatedWaitTest(unittest.TestCase):
    """A rate limit waits only on the wait CodeRabbit edited in just before it."""

    def test_the_trigger_is_permitted_at_retry_time_and_not_a_second_before(self) -> None:
        self.assertEqual(state("1043", "2026-09-30T17:15:27Z")["state"], "waiting")
        self.assertEqual(state("1043", "2026-09-30T17:15:28Z")["state"], "trigger-incremental")

    def test_an_edit_sixty_seconds_before_the_status_correlates(self) -> None:
        gh = Replay("1043", now="2026-09-30T17:05:00Z")
        gh.move_version("1043", 5880781313, "2026-09-30T17:02:28Z", "2026-09-30T17:01:29Z")
        result = observe(gh, "1043")
        self.assertEqual(result["state"], "waiting")
        self.assertEqual(result["retryAt"], "2026-09-30T17:14:29Z")

    def test_an_edit_sixty_one_seconds_before_the_status_leaves_the_wait_unknown(self) -> None:
        gh = Replay("1043", now="2026-09-30T17:05:00Z")
        gh.move_version("1043", 5880781313, "2026-09-30T17:02:28Z", "2026-09-30T17:01:28Z")
        result = observe(gh, "1043")
        self.assertEqual(result["state"], "rate-limited-unknown-wait")
        self.assertEqual(result["rateLimitedAt"], "2026-09-30T17:02:29Z")
        self.assertIsNone(result["nextMode"])
        self.assertIsNone(result["retryAt"])

    def test_an_edit_after_the_status_does_not_correlate(self) -> None:
        gh = Replay("1043", now="2026-09-30T17:05:00Z")
        gh.move_version("1043", 5880781313, "2026-09-30T17:02:28Z", "2026-09-30T17:02:30Z")
        self.assertEqual(observe(gh, "1043")["state"], "rate-limited-unknown-wait")

    def test_a_notice_gone_from_the_current_body_is_read_from_its_history(self) -> None:
        gh = Replay("1059", now="2026-09-29T18:20:00Z")
        body = gh.visible_comments("1059")[0]["body"]
        self.assertNotRegex(body, ADAPTER.STATED_WAIT)
        result = observe(gh, "1059")
        self.assertEqual(result["state"], "waiting")
        self.assertEqual(result["rateLimit"]["wait"]["editedAt"], "2026-09-29T18:06:27Z")
        self.assertEqual(result["retryAt"], "2026-09-29T18:29:27Z")
        gh.now = at("2026-09-29T18:29:27Z")
        self.assertEqual(observe(gh, "1059")["state"], "trigger-incremental")

    def test_each_recorded_rate_limit_pairs_with_its_own_edit(self) -> None:
        expected = {
            "2026-09-30T17:25:00Z": "2026-09-30T17:24:41Z",
            "2026-09-30T17:30:00Z": "2026-09-30T17:25:58Z",
            "2026-09-30T18:00:00Z": "2026-09-30T17:58:19Z",
        }
        for now, edited in expected.items():
            with self.subTest(now=now):
                self.assertEqual(state("1095", now)["rateLimit"]["wait"]["editedAt"], edited)

    def test_the_newest_wait_in_the_scanned_repositories_gates_a_trigger(self) -> None:
        result = state("1043", "2026-09-30T17:15:40Z", *NEIGHBOURS)
        self.assertEqual(result["accountWait"]["newest"]["pr"], 1055)
        self.assertEqual(result["accountWait"]["newest"]["editedAt"], "2026-09-30T17:02:50Z")
        self.assertEqual(result["state"], "waiting")
        self.assertEqual((result["retryAt"], result["retrySource"]), ("2026-09-30T17:15:50Z", "account"))
        self.assertEqual(state("1043", "2026-09-30T17:15:50Z", *NEIGHBOURS)["state"], "trigger-incremental")

    def test_a_status_on_a_commit_two_pull_requests_share_is_paired_once(self) -> None:
        # #1095 has recent CodeRabbit comments but none near #1055's refusal.
        gh = Replay("1043", "1055", "1095", now="2026-09-30T17:30:00Z")
        shared = gh.case("1055")["head"]
        gh.case("1095")["statuses"][shared] = gh.case("1055")["statuses"][shared]
        result = observe(gh, "1043")
        self.assertEqual(result["accountWait"]["uncorrelatedRateLimits"], 0)

    def test_an_account_wait_holds_a_head_that_has_no_rate_limit_of_its_own(self) -> None:
        gh = Replay("1043", *NEIGHBOURS, now="2026-09-30T17:10:00Z")
        gh.case("1043")["statuses"][gh.case("1043")["head"]] = gh.case("1043")["statuses"][
            gh.case("1043")["head"]
        ][:2]
        result = observe(gh, "1043")
        self.assertEqual(result["status"]["kind"], "draft-skip")
        self.assertEqual((result["state"], result["retrySource"]), ("waiting", "account"))


class EscalationTest(unittest.TestCase):
    """An unconfirmed completion gets one full review per head, then blocks."""

    def replay(self, now: str) -> Replay:
        gh = Replay("1083", now=now)  # Recorded while the PR was being closed; replayed open.
        return gh

    def test_one_full_review_then_blocked(self) -> None:
        first = observe(self.replay("2026-09-30T08:29:00Z"), "1083")
        self.assertEqual(first["status"]["description"], "Review completed")
        self.assertEqual([trigger["mode"] for trigger in first["triggers"]], ["incremental"])
        self.assertEqual(first["state"], "trigger-full")
        self.assertEqual(observe(self.replay("2026-09-30T08:29:30Z"), "1083")["state"], "triggered")
        last = observe(self.replay("2026-09-30T08:30:00Z"), "1083")
        self.assertEqual([trigger["mode"] for trigger in last["triggers"]], ["incremental", "full"])
        self.assertEqual(last["state"], "blocked-unconfirmed")

    def test_a_full_review_requested_for_an_earlier_head_does_not_count(self) -> None:
        gh = self.replay("2026-09-30T08:29:00Z")
        earlier = next(item for item in gh.visible_comments("1083") if item["body"] == "@coderabbitai full review")
        self.assertLess(at(earlier["created_at"]), at(observe(gh, "1083")["headArrival"]["at"]))
        self.assertEqual(observe(gh, "1083")["state"], "trigger-full")

    def test_run_posts_one_full_review_and_stops_blocked(self) -> None:
        gh = Replay("1089", now="2026-09-30T13:20:00Z")

        def answer(_endpoint: str, fields: dict[str, str]) -> None:
            posted = iso(gh.now)
            gh.add_comment("1089", fields["body"], posted)
            gh.add_status("1089", "Review completed", iso(gh.now + 30))

        gh.on_post = answer
        final, _reason, value = run(gh, "1089", "2026-09-30T14:00:00Z")
        self.assertEqual(final, "blocked-unconfirmed")
        self.assertEqual([fields["body"] for _endpoint, fields, _when in gh.posts], ["@coderabbitai full review"])
        self.assertEqual(value["triggers"][0]["mode"], "full")


class RunTest(unittest.TestCase):
    def test_recorded_1043_triggers_once_exactly_when_the_wait_ends(self) -> None:
        gh = Replay("1043", now="2026-09-30T17:05:00Z")
        gh.on_post = lambda _endpoint, fields: gh.add_comment("1043", fields["body"], iso(gh.now))
        final, _reason, value = run(gh, "1043", "2026-09-30T17:30:00Z")
        self.assertEqual(len(gh.posts), 1)
        endpoint, fields, when = gh.posts[0]
        self.assertEqual(endpoint, f"repos/{REPO}/issues/1043/comments")
        self.assertEqual(fields, {"body": "@coderabbitai review"})
        self.assertEqual(iso(when), "2026-09-30T17:15:28Z")
        self.assertEqual(final, "triggered")

    def test_a_trigger_not_yet_listed_is_never_posted_twice(self) -> None:
        gh = Replay("1043", now="2026-09-30T17:20:00Z")
        final, _reason, _value = run(gh, "1043", "2026-09-30T17:30:00Z")
        self.assertEqual(len(gh.posts), 1)
        self.assertEqual(final, "trigger-incremental")

    def test_an_unknown_wait_is_polled_and_never_triggered(self) -> None:
        gh = Replay("1043", now="2026-09-30T17:05:00Z")
        gh.move_version("1043", 5880781313, "2026-09-30T17:02:28Z", "2026-09-30T17:00:00Z")
        final, reason, value = run(gh, "1043", "2026-09-30T17:40:00Z")
        self.assertEqual(final, "rate-limited-unknown-wait")
        self.assertIn("deadline", reason)
        self.assertEqual(gh.posts, [])
        self.assertEqual(value["pullRequests"][0]["rateLimitedAt"], "2026-09-30T17:02:29Z")

    def test_an_unknown_wait_ends_when_a_new_status_arrives(self) -> None:
        gh = Replay("1043", now="2026-09-30T17:05:00Z")
        gh.move_version("1043", 5880781313, "2026-09-30T17:02:28Z", "2026-09-30T17:00:00Z")
        gh.add_status("1043", "Review in progress", "2026-09-30T17:20:00Z", state="pending")
        gh.add_status("1043", "Review skipped: 474 files exceed the limit of 150", "2026-09-30T17:21:00Z")
        final, _reason, _value = run(gh, "1043", "2026-09-30T17:40:00Z")
        self.assertEqual(final, "skipped")
        self.assertEqual(gh.posts, [])

    def test_in_progress_is_polled_until_the_review_completes(self) -> None:
        gh = Replay("1095", now="2026-09-30T19:12:00Z")
        final, _reason, _value = run(gh, "1095", "2026-09-30T19:40:00Z", interval=30)
        self.assertEqual(final, "clean-complete")
        self.assertGreaterEqual(gh.now, at("2026-09-30T19:17:22Z"))
        self.assertEqual(gh.posts, [])

    def test_an_expired_deadline_never_posts(self) -> None:
        gh = Replay("1043", now="2026-09-30T17:20:00Z")
        final, reason, _value = run(gh, "1043", "2026-09-30T17:20:00Z")
        self.assertEqual(final, "trigger-incremental")
        self.assertIn("before the permitted trigger", reason)
        self.assertEqual(gh.posts, [])


class AccountLockTest(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        patcher = mock.patch.object(ADAPTER, "lock_directory", lambda: Path(self.directory.name))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.directory.cleanup)

    def test_status_names_the_run_holding_the_lock(self) -> None:
        self.assertEqual(ADAPTER.lock_status("reviewer")["held"], False)
        holder = {"repo": REPO, "pr": 1043, "head": FIXTURE["cases"]["1043"]["head"]}
        handle = ADAPTER.acquire_lock("reviewer", holder, 0, 1)
        self.assertIsNotNone(handle)
        try:
            status = ADAPTER.lock_status("reviewer")
            self.assertTrue(status["held"])
            self.assertEqual(
                {key: status["holder"][key] for key in ("repo", "pr", "head", "login")},
                holder | {"login": "reviewer"},
            )
            self.assertIsInstance(status["holder"]["pid"], int)
            self.assertIsNone(ADAPTER.acquire_lock("reviewer", {"pr": 1055}, 0, 1))
        finally:
            ADAPTER.release_lock(handle)
        self.assertEqual(ADAPTER.lock_status("reviewer"), {"path": status["path"], "held": False, "holder": None})

    def test_status_command_reports_the_holder_and_run_reports_lock_held(self) -> None:
        gh = Replay("1087", now="2026-09-30T10:26:00Z")
        read = gh.rest
        gh.rest = lambda endpoint, *args: {"login": "reviewer"} if endpoint == "user" else read(endpoint, *args)
        head = gh.case("1087")["head"]
        handle = ADAPTER.acquire_lock("reviewer", {"repo": REPO, "pr": 1043, "head": "abc"}, 0, 1)
        self.addCleanup(ADAPTER.release_lock, handle)

        def main(*argv: str) -> dict[str, Any]:
            output: list[str] = []
            with mock.patch.object(ADAPTER, "Gh", lambda _metrics: gh), mock.patch.object(
                ADAPTER.sys, "argv", ["coderabbit_adapter.py", *argv]
            ), mock.patch("builtins.print", output.append):
                self.assertEqual(ADAPTER.main(), 0)
            return json.loads(output[0])

        status = main("status", "--repo", REPO, "--pr", "1087", "--head", f"1087={head}", "--json")
        self.assertEqual(status["state"], "satisfied")
        self.assertEqual(status["observation"]["pullRequests"][0]["state"], "clean-complete")
        self.assertEqual(status["observation"]["lock"]["holder"]["pr"], 1043)
        blocked = main(
            "run", "--repo", REPO, "--pr", "1087", "--head", head,
            "--deadline", "2000-01-01T00:00:00Z", "--interval", "1", "--json",
        )
        self.assertEqual(blocked["state"], "lock-held")
        self.assertEqual(blocked["observation"]["lock"]["holder"]["pr"], 1043)
        self.assertEqual(gh.posts, [])


class ContractTest(unittest.TestCase):
    def test_only_the_two_included_review_commands_exist(self) -> None:
        self.assertEqual(set(ADAPTER.TRIGGERS.values()), {"@coderabbitai review", "@coderabbitai full review"})
        commands = set(re.findall(r"@coderabbitai[a-z ]*", MODULE_PATH.read_text()))
        self.assertEqual(commands, {"@coderabbitai review", "@coderabbitai full review"})

    def test_cli_keeps_status_and_run(self) -> None:
        status = ADAPTER.parser().parse_args(
            ["status", "--repo", REPO, "--pr", "1", "--head", "1=abc", "--scan-repo", "o/r", "--json"]
        )
        self.assertEqual((status.command, status.pr, status.head, status.scan_repo), ("status", [1], ["1=abc"], ["o/r"]))
        run_args = ADAPTER.parser().parse_args(
            ["run", "--repo", REPO, "--pr", "1", "--head", "abc", "--deadline", "2026-10-01T00:00:00Z", "--json"]
        )
        self.assertEqual((run_args.command, run_args.interval), ("run", 60.0))

    def test_status_aggregates_every_pull_request(self) -> None:
        def aggregate(*states: str) -> str:
            return ADAPTER.aggregate_status({"pullRequests": [{"state": value} for value in states]})[0]

        self.assertEqual(aggregate("review-complete", "clean-complete"), "satisfied")
        self.assertEqual(aggregate("review-complete", "invalidated", "skipped"), "invalidated")
        self.assertEqual(aggregate("waiting", "blocked-unconfirmed"), "blocked")
        self.assertEqual(aggregate("review-complete", "rate-limited-unknown-wait"), "pending")


if __name__ == "__main__":
    unittest.main()
