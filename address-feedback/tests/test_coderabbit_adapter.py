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
from urllib.parse import urlparse


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
        # Answers a POST as GitHub and CodeRabbit would; returns the comment's id.
        self.on_post: Callable[[str, dict[str, str]], int] | None = None
        self.requests: list[str] = []
        self.closed: set[str] = set()
        self.unreadable_histories: set[int] = set()
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

    def add_version(self, pr: str, identifier: int, body: str, when: str) -> None:
        self.comment(pr, identifier)["versions"].append([when, body])
        self.comment(pr, identifier)["versions"].sort()

    def add_suite(self, pr: str, when: str, branch: str) -> None:
        case = self.cases[pr]
        case["checkSuites"][case["head"]].append({"created_at": when, "head_branch": branch, "app": "other"})

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
                return {"id": self.on_post(endpoint, dict(fields or {}))}
            self.next_id += 1
            return {"id": self.next_id}
        self.requests.append(endpoint)
        match = re.fullmatch(r"repos/[^/]+/[^/]+/pulls/(\d+)", endpoint)
        if match and self.by_number(int(match.group(1))):
            pr = match.group(1)
            case = self.cases[pr]
            draft = case["draft"] or bool(case["readyAt"] and self.now < at(case["readyAt"]))
            return {
                "head": {"sha": case["head"], "ref": case["ref"]},
                "state": "closed" if pr in self.closed else "open",
                "draft": draft,
                "created_at": case["createdAt"],
            }
        raise ADAPTER.WaitError(f"gh: Not Found (HTTP 404) {endpoint}")

    def rest_pages(self, endpoint: str) -> list[Any]:
        self.requests.append(endpoint)
        path = urlparse(endpoint).path
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
        raise AssertionError(f"unexpected read {endpoint}")

    def graphql(self, query: str, variables: dict[str, Any]) -> dict[str, Any]:
        if "READY_FOR_REVIEW_EVENT" in query:
            self.requests.append(f"graphql:ready:{variables['number']}")
            ready = self.cases[str(variables["number"])]["readyAt"]
            nodes = [{"createdAt": ready}] if ready and at(ready) <= self.now else []
            return {"repository": {"pullRequest": {"timelineItems": {"nodes": nodes}}}}
        if "userContentEdits" in query:
            self.requests.append(f"graphql:{variables['id']}")
            identifier = int(variables["id"].removeprefix("IC_"))
            if identifier in self.unreadable_histories:
                raise ADAPTER.WaitError("GitHub GraphQL error: edit history unavailable")
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
        self.requests.append(f"graphql:open:{variables['name']}")
        nodes = []
        for pr, case in self.cases.items():
            if pr in self.closed:
                continue
            latest: dict[str, dict[str, Any]] = {}
            for item in reversed(self.statuses(case["head"])):
                latest[item["context"]] = {
                    "context": item["context"],
                    "state": item["state"].upper(),
                    "description": item["description"],
                    "createdAt": item["created_at"],
                    "creator": {"login": item["creator"]["login"].removesuffix("[bot]")},
                }
            status = {"contexts": list(latest.values())} if latest else None
            nodes.append({"number": int(pr), "commits": {"nodes": [{"commit": {"oid": case["head"], "status": status}}]}})
        return {"repository": {"pullRequests": {"pageInfo": {"hasNextPage": False, "endCursor": None}, "nodes": nodes}}}


def observe(gh: Replay, pr: str, head: str | None = None) -> dict[str, Any]:
    expected = head or gh.cases[pr]["head"]
    value = ADAPTER.observation(gh, REPO, [int(pr)], {int(pr): expected}, [REPO], gh.now)
    return value["pullRequests"][0] | {"account": value["account"]}


def state(pr: str, now: str, *others: str) -> dict[str, Any]:
    return observe(Replay(pr, *others, now=now), pr)


def observed_at(gh: Replay, pr: str, now: str) -> dict[str, Any]:
    gh.now = at(now)
    return observe(gh, pr)


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


def answering(gh: Replay, pr: str, *answers: Callable[[float], None]) -> None:
    """GitHub lists each posted trigger; CodeRabbit then gives the next answer."""
    pending = list(answers)

    def post(_endpoint: str, fields: dict[str, str]) -> int:
        identifier = gh.add_comment(pr, fields["body"], iso(gh.now))
        if pending:
            pending.pop(0)(gh.now)
        return identifier

    gh.on_post = post


SUMMARY_1043 = 5880781313
SUMMARY_1055 = 5880792642
SUMMARY_1087 = 5907716986
REPLY = "<!-- This is an auto-generated reply by CodeRabbit -->\n> Next included review available in {}."


class HeadStatusTest(unittest.TestCase):
    """Each CodeRabbit status on the head, as recorded, reaches its state."""

    def test_draft_skip_on_a_draft_waits_for_it_to_be_ready(self) -> None:
        result = state("1043", "2026-09-30T16:30:00Z")
        self.assertEqual(result["status"]["description"], "Review skipped: draft pull request")
        self.assertEqual(result["state"], "draft")
        self.assertIsNone(result["nextMode"])

    def test_review_in_progress_is_waited_on(self) -> None:
        result = state("1095", "2026-09-30T19:12:00Z")
        self.assertEqual(result["status"]["description"], "Review in progress")
        self.assertEqual(result["state"], "in-progress")
        self.assertEqual((result["since"], result["boundAt"]), ("2026-09-30T19:10:35Z", "2026-09-30T20:10:35Z"))
        self.assertIsNone(result["nextMode"])

    def test_rate_limit_waits_for_the_stated_wait_edited_in_before_it(self) -> None:
        result = state("1043", "2026-09-30T17:05:00Z")
        self.assertEqual(result["status"]["description"], "Review rate limited")
        self.assertEqual(result["state"], "waiting")
        self.assertEqual(result["rateLimit"]["wait"]["editedAt"], "2026-09-30T17:02:28Z")
        self.assertEqual(result["rateLimit"]["wait"]["statedSeconds"], 12 * 60)
        self.assertEqual(result["rateLimit"]["wait"]["availableAt"], "2026-09-30T17:14:28Z")
        self.assertEqual((result["retryAt"], result["retrySource"]), ("2026-09-30T17:15:28Z", "pull-request"))
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

    def test_a_review_with_no_actionable_comments_and_no_findings_is_not_a_findings_review(self) -> None:
        gh = Replay("1040", now="2026-09-30T01:43:00Z")
        for review in gh.case("1040")["reviews"]:
            review["body"] = "**Actionable comments posted: 0**"
        result = observe(gh, "1040")
        self.assertIsNone(result["findingsReview"])
        self.assertEqual(result["state"], "trigger-full")

    def test_coverage_marker_for_the_head_completes_a_clean_pass(self) -> None:
        for pr, now in (("1087", "2026-09-30T10:26:00Z"), ("1095", "2026-09-30T19:18:00Z")):
            with self.subTest(pr=pr):
                result = state(pr, now)
                self.assertEqual(result["state"], "clean-complete")
                self.assertEqual(result["cleanReview"]["coveredCommitId"], FIXTURE["cases"][pr]["head"])

    def test_a_coverage_marker_of_another_kind_does_not_complete(self) -> None:
        gh = Replay("1087", now="2026-09-30T10:26:00Z")
        summary = gh.comment("1087", 5907716986)
        self.assertIn('"kind":"reviewed"', summary["versions"][-1][1])
        summary["versions"][-1][1] = summary["versions"][-1][1].replace('"kind":"reviewed"', '"kind":"skipped"')
        result = observe(gh, "1087")
        self.assertIsNone(result["cleanReview"])
        self.assertEqual(result["state"], "trigger-full")

    def test_completed_status_without_review_or_marker_escalates_to_one_full_review(self) -> None:
        result = state("1089", "2026-09-30T13:20:00Z")  # Synthetic: #1089 merged at 13:19:33.
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


class AutomaticReviewTest(unittest.TestCase):
    """CodeRabbit's own review of a new or ready head is awaited before any trigger."""

    def test_a_ready_head_without_a_review_status_waits_120_s_from_its_push(self) -> None:
        gh = Replay("1043", now="2026-09-30T16:17:05Z")
        gh.case("1043")["readyAt"] = None  # Replayed as ready from the push.
        first = observe(gh, "1043")
        self.assertIsNone(first["status"])
        self.assertEqual(first["automaticReview"], {"from": "2026-09-30T16:16:59Z", "source": "head-check-suite"})
        self.assertEqual((first["state"], first["boundAt"]), ("awaiting-automatic", "2026-09-30T16:18:59Z"))
        self.assertEqual(observed_at(gh, "1043", "2026-09-30T16:18:58Z")["state"], "awaiting-automatic")
        last = observed_at(gh, "1043", "2026-09-30T16:18:59Z")
        self.assertEqual((last["state"], last["nextMode"]), ("trigger-incremental", "incremental"))

    def test_a_head_marked_ready_waits_120_s_from_the_ready_event(self) -> None:
        # Recorded: marked ready 17:02:10, CodeRabbit's own review in progress 17:02:23.
        gh = Replay("1043", now="2026-09-30T17:02:15Z")
        result = observe(gh, "1043")
        self.assertEqual(result["status"]["kind"], "draft-skip")
        self.assertEqual(result["automaticReview"], {"from": "2026-09-30T17:02:10Z", "source": "ready-for-review"})
        self.assertEqual((result["state"], result["since"], result["boundAt"]), (
            "awaiting-automatic", "2026-09-30T17:02:10Z", "2026-09-30T17:04:10Z"
        ))
        self.assertIsNone(result["nextMode"])
        self.assertEqual(observed_at(gh, "1043", "2026-09-30T17:02:23Z")["state"], "in-progress")

    def test_a_pull_request_opened_after_the_push_waits_from_its_opening(self) -> None:
        gh = Replay("1043", now="2026-09-30T16:19:10Z")
        gh.case("1043")["readyAt"] = None
        gh.case("1043")["createdAt"] = "2026-09-30T16:17:30Z"  # Synthetic: opened after the push.
        result = observe(gh, "1043")
        self.assertEqual(result["automaticReview"], {"from": "2026-09-30T16:17:30Z", "source": "opened"})
        self.assertEqual((result["state"], result["boundAt"]), ("awaiting-automatic", "2026-09-30T16:19:30Z"))

    def test_a_head_marked_ready_after_an_expired_refusal_waits_120_s_from_the_ready_event(self) -> None:
        gh = Replay("1043", now="2026-09-30T17:20:00Z")
        gh.case("1043")["readyAt"] = "2026-09-30T17:19:55Z"  # Synthetic: marked ready again.
        result = observe(gh, "1043")
        self.assertEqual(result["status"]["kind"], "rate-limited")
        self.assertEqual((result["state"], result["boundAt"]), ("awaiting-automatic", "2026-09-30T17:21:55Z"))
        self.assertEqual(observed_at(gh, "1043", "2026-09-30T17:21:54Z")["state"], "awaiting-automatic")
        self.assertEqual(observed_at(gh, "1043", "2026-09-30T17:21:55Z")["state"], "trigger-incremental")


class BoundTest(unittest.TestCase):
    """Every state that waits on CodeRabbit becomes blocked after its bound."""

    def test_an_unanswered_trigger_blocks_after_ten_minutes(self) -> None:
        gh = Replay("1043", now="2026-09-30T17:25:59Z")
        gh.add_comment("1043", "@coderabbitai review", "2026-09-30T17:16:00Z")
        waiting = observe(gh, "1043")
        self.assertEqual((waiting["state"], waiting["boundAt"]), ("triggered", "2026-09-30T17:26:00Z"))
        blocked = observed_at(gh, "1043", "2026-09-30T17:26:00Z")
        self.assertEqual((blocked["state"], blocked["since"]), ("blocked-unanswered", "2026-09-30T17:16:00Z"))
        self.assertIsNone(blocked["nextMode"])

    def test_a_status_in_the_same_second_as_a_trigger_is_not_its_answer(self) -> None:
        gh = Replay("1043", now="2026-09-30T17:05:00Z")
        gh.add_comment("1043", "@coderabbitai review", "2026-09-30T17:02:29Z")
        self.assertEqual(observe(gh, "1043")["state"], "triggered")
        blocked = observed_at(gh, "1043", "2026-09-30T17:12:29Z")
        self.assertEqual((blocked["state"], blocked["since"]), ("blocked-unanswered", "2026-09-30T17:02:29Z"))

    def test_a_review_in_progress_for_an_hour_blocks_as_stalled(self) -> None:
        gh = Replay("1043", now="2026-09-30T18:19:59Z")
        gh.add_status("1043", "Review in progress", "2026-09-30T17:20:00Z", state="pending")
        self.assertEqual(observe(gh, "1043")["state"], "in-progress")
        blocked = observed_at(gh, "1043", "2026-09-30T18:20:00Z")
        self.assertEqual((blocked["state"], blocked["since"]), ("blocked-stalled", "2026-09-30T17:20:00Z"))

    def test_a_refusal_without_a_stated_wait_blocks_after_fifteen_minutes(self) -> None:
        gh = Replay("1043", now="2026-09-30T17:17:28Z")
        gh.move_version("1043", SUMMARY_1043, "2026-09-30T17:02:28Z", "2026-09-30T17:00:00Z")
        unknown = observe(gh, "1043")
        self.assertEqual((unknown["state"], unknown["boundAt"]), ("rate-limited-unknown-wait", "2026-09-30T17:17:29Z"))
        blocked = observed_at(gh, "1043", "2026-09-30T17:17:29Z")
        self.assertEqual((blocked["state"], blocked["since"]), ("blocked-unknown-wait", "2026-09-30T17:02:29Z"))
        self.assertIsNone(blocked["retryAt"])


class StatedWaitTest(unittest.TestCase):
    """A rate limit waits only on the wait CodeRabbit edited into its summary just before it."""

    def test_the_trigger_is_permitted_at_retry_time_and_not_a_second_before(self) -> None:
        self.assertEqual(state("1043", "2026-09-30T17:15:27Z")["state"], "waiting")
        self.assertEqual(state("1043", "2026-09-30T17:15:28Z")["state"], "trigger-incremental")

    def test_an_edit_sixty_seconds_before_the_status_correlates(self) -> None:
        gh = Replay("1043", now="2026-09-30T17:05:00Z")
        gh.move_version("1043", SUMMARY_1043, "2026-09-30T17:02:28Z", "2026-09-30T17:01:29Z")
        result = observe(gh, "1043")
        self.assertEqual(result["state"], "waiting")
        self.assertEqual(result["retryAt"], "2026-09-30T17:14:29Z")

    def test_an_edit_sixty_one_seconds_before_the_status_leaves_the_wait_unknown(self) -> None:
        gh = Replay("1043", now="2026-09-30T17:05:00Z")
        gh.move_version("1043", SUMMARY_1043, "2026-09-30T17:02:28Z", "2026-09-30T17:01:28Z")
        result = observe(gh, "1043")
        self.assertEqual(result["state"], "rate-limited-unknown-wait")
        self.assertEqual(result["since"], "2026-09-30T17:02:29Z")
        self.assertIsNone(result["retryAt"])

    def test_an_edit_after_the_status_does_not_correlate(self) -> None:
        gh = Replay("1043", now="2026-09-30T17:05:00Z")
        gh.move_version("1043", SUMMARY_1043, "2026-09-30T17:02:28Z", "2026-09-30T17:02:30Z")
        self.assertEqual(observe(gh, "1043")["state"], "rate-limited-unknown-wait")

    def test_an_unreadable_edit_history_leaves_the_wait_unknown(self) -> None:
        gh = Replay("1043", now="2026-09-30T17:05:00Z")
        gh.unreadable_histories.add(SUMMARY_1043)
        result = observe(gh, "1043")
        self.assertEqual(result["state"], "rate-limited-unknown-wait")
        self.assertIn("could not be read", result["reason"])

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

    def test_two_recorded_summary_versions_in_the_window_take_the_later_retry_time(self) -> None:
        # Each newer version states a wait that ends earlier than the older one's.
        cases = {
            "1062": ("2026-09-29T19:15:00Z", "2026-09-29T19:08:52Z", 20 * 60, "2026-09-29T19:29:52Z"),
            "1084": ("2026-09-30T07:50:00Z", "2026-09-30T07:42:17Z", 45 * 60, "2026-09-30T08:28:17Z"),
        }
        for pr, (now, edited, seconds, retry) in cases.items():
            with self.subTest(pr=pr):
                result = state(pr, now)
                self.assertEqual(result["state"], "waiting")
                self.assertEqual(result["rateLimit"]["wait"]["editedAt"], edited)
                self.assertEqual(result["rateLimit"]["wait"]["statedSeconds"], seconds)
                self.assertEqual(result["retryAt"], retry)

    def test_a_bot_reply_is_not_the_notice(self) -> None:
        for wait, retry in (("1 minute", "2026-09-30T17:15:28Z"), ("50 minutes", "2026-09-30T17:15:28Z")):
            with self.subTest(reply=wait):
                gh = Replay("1043", now="2026-09-30T17:05:00Z")
                gh.add_comment("1043", REPLY.format(wait), "2026-09-30T17:02:29Z", login="coderabbitai[bot]")
                result = observe(gh, "1043")
                self.assertEqual(result["rateLimit"]["wait"]["commentId"], SUMMARY_1043)
                self.assertEqual((result["state"], result["retryAt"]), ("waiting", retry))

    def test_the_latest_retry_in_the_scanned_repositories_gates_a_trigger(self) -> None:
        result = state("1043", "2026-09-30T17:15:40Z", *NEIGHBOURS)
        latest = next(item for item in result["account"]["refusals"] if item["prs"] == [1055])
        self.assertEqual(latest["wait"]["retryAt"], "2026-09-30T17:15:50Z")
        self.assertEqual(result["state"], "waiting")
        self.assertEqual((result["retryAt"], result["retrySource"]), ("2026-09-30T17:15:50Z", "account"))
        self.assertEqual(state("1043", "2026-09-30T17:15:50Z", *NEIGHBOURS)["state"], "trigger-incremental")

    def test_a_refusal_on_a_head_several_open_pull_requests_share_pairs_with_any_of_their_summaries(self) -> None:
        # Synthetic: #1089 merged at 13:19:33 and is replayed open.
        for owner, sharer in (("1055", "1095"), ("1095", "1055")):
            with self.subTest(owner=owner):
                gh = Replay("1089", sharer, owner, now="2026-09-30T17:30:00Z")
                gh.case(sharer)["head"] = gh.case(owner)["head"]
                shared = observe(gh, "1089")["account"]["refusals"]
                self.assertEqual([item["prs"] for item in shared], [[int(sharer), int(owner)]])
                self.assertEqual(shared[0]["wait"]["commentId"], gh.case(owner)["comments"][0]["id"])

    def test_another_pull_requests_summary_does_not_shorten_a_shared_heads_wait(self) -> None:
        # Synthetic: #1089 merged at 13:19:33 and is replayed open.
        gh = Replay("1089", "1043", "1095", now="2026-09-30T17:05:00Z")
        gh.case("1095")["head"] = gh.case("1043")["head"]
        decoy = ADAPTER.SUMMARY_MARKER + "\n> Next included review available in 1 minute."
        gh.add_comment("1095", decoy, "2026-09-30T17:02:29Z", login="coderabbitai[bot]")
        result = observe(gh, "1089")
        self.assertEqual(result["account"]["refusals"][0]["wait"]["commentId"], SUMMARY_1043)
        self.assertEqual((result["state"], result["retryAt"]), ("waiting", "2026-09-30T17:15:28Z"))

    def test_an_account_wait_holds_a_head_that_has_no_rate_limit_of_its_own(self) -> None:
        gh = Replay("1043", *NEIGHBOURS, now="2026-09-30T17:10:00Z")
        gh.case("1043")["statuses"][gh.case("1043")["head"]] = gh.case("1043")["statuses"][
            gh.case("1043")["head"]
        ][:2]
        result = observe(gh, "1043")
        self.assertEqual(result["status"]["kind"], "draft-skip")
        self.assertEqual((result["state"], result["retrySource"]), ("waiting", "account"))

    def test_a_refusal_without_a_stated_wait_holds_triggers_on_every_pull_request(self) -> None:
        # Synthetic: #1089 merged at 13:19:33 and is replayed open.
        gh = Replay("1089", "1043", now="2026-09-30T17:05:00Z")
        gh.move_version("1043", SUMMARY_1043, "2026-09-30T17:02:28Z", "2026-09-30T17:00:00Z")
        self.assertEqual(observe(gh, "1043")["state"], "rate-limited-unknown-wait")
        held = observe(gh, "1089")
        self.assertEqual(held["state"], "waiting-account-unknown")
        self.assertEqual(held["nextMode"], "full")
        self.assertEqual(held["unmatchedRateLimit"]["prs"], [1043])
        self.assertEqual(held["unmatchedRateLimit"]["statusAt"], "2026-09-30T17:02:29Z")
        self.assertEqual(held["boundAt"], "2026-09-30T17:17:29Z")
        self.assertEqual(observed_at(gh, "1089", "2026-09-30T17:17:28Z")["state"], "waiting-account-unknown")
        blocked = observed_at(gh, "1089", "2026-09-30T17:17:29Z")
        self.assertEqual((blocked["state"], blocked["since"]), ("blocked-account-unknown-wait", "2026-09-30T17:02:29Z"))
        self.assertIsNone(blocked["nextMode"])


class AccountTest(unittest.TestCase):
    """CodeRabbit's newest status on every open head holds a trigger on the account.

    Synthetic: #1089 merged at 13:19:33 and is replayed open.
    """

    def unexplained(self, *others: str, now: str) -> Replay:
        gh = Replay("1089", "1043", *others, now=now)
        gh.move_version("1043", SUMMARY_1043, "2026-09-30T17:02:28Z", "2026-09-30T17:00:00Z")
        return gh

    def test_a_refusal_whose_summary_was_edited_long_before_still_holds_the_account(self) -> None:
        gh = Replay("1089", "1043", now="2026-09-30T17:05:00Z")
        for index, version in enumerate(gh.comment("1043", SUMMARY_1043)["versions"]):
            version[0] = iso(at("2026-09-30T14:00:00Z") + index)
        held = observe(gh, "1089")
        self.assertEqual((held["state"], held["unmatchedRateLimit"]["prs"]), ("waiting-account-unknown", [1043]))

    def test_a_later_review_or_stated_wait_on_the_account_releases_an_unexplained_refusal(self) -> None:
        releases = {
            "review in progress": ("1087", "Review in progress", "pending"),
            "review completed": ("1087", "Review completed", "success"),
            "the refused head's own newer status": ("1043", "Review skipped: draft pull request", "success"),
        }
        for label, (pr, description, status) in releases.items():
            with self.subTest(label):
                gh = self.unexplained("1087", now="2026-09-30T17:10:00Z")
                self.assertEqual(observe(gh, "1089")["state"], "waiting-account-unknown")
                gh.add_status(pr, description, "2026-09-30T17:05:00Z", state=status)
                self.assertEqual(observe(gh, "1089")["state"], "trigger-full")
                if pr != "1043":
                    self.assertEqual(observe(gh, "1043")["state"], "trigger-incremental")
        with self.subTest("a later refusal with a stated wait"):
            released = observe(self.unexplained("1055", now="2026-09-30T17:10:00Z"), "1089")
            self.assertEqual((released["state"], released["retryAt"]), ("waiting", "2026-09-30T17:15:50Z"))
            self.assertEqual(observe(self.unexplained("1055", now="2026-09-30T17:15:50Z"), "1089")["state"], "trigger-full")

    def test_the_oldest_unexplained_refusal_blocks_the_account_fifteen_minutes_after_it(self) -> None:
        gh = self.unexplained("1055", now="2026-09-30T17:17:28Z")
        gh.move_version("1055", SUMMARY_1055, "2026-09-30T17:02:50Z", "2026-09-30T17:00:00Z")
        held = observe(gh, "1089")
        self.assertEqual((held["state"], held["unmatchedRateLimit"]["prs"]), ("waiting-account-unknown", [1043]))
        blocked = observed_at(gh, "1089", "2026-09-30T17:17:29Z")
        self.assertEqual((blocked["state"], blocked["since"]), ("blocked-account-unknown-wait", "2026-09-30T17:02:29Z"))

    def test_the_latest_outstanding_retry_holds_the_account_whatever_the_edit_order(self) -> None:
        gh = Replay("1089", "1043", "1055", now="2026-09-30T17:20:00Z")
        for pr, summary, minutes, edited in (("1043", SUMMARY_1043, 50, "17:04:00"), ("1055", SUMMARY_1055, 2, "17:10:00")):
            notice = ADAPTER.SUMMARY_MARKER + f"\n> Next included review available in {minutes} minutes."
            gh.add_version(pr, summary, notice, f"2026-09-30T{edited}Z")
            gh.add_status(pr, "Review rate limited", iso(at(f"2026-09-30T{edited}Z") + 1))
        for now in ("2026-09-30T17:11:00Z", "2026-09-30T17:20:00Z"):
            held = observed_at(gh, "1089", now)
            self.assertEqual((held["state"], held["retryAt"]), ("waiting", "2026-09-30T17:55:00Z"))
        self.assertEqual(observed_at(gh, "1089", "2026-09-30T17:55:00Z")["state"], "trigger-full")


class OpenHeadsTest(unittest.TestCase):
    """The account scan reads every page of open pull requests, up to a bound."""

    @staticmethod
    def pages(count: int, refused_on: int) -> Callable[[str, dict[str, Any]], dict[str, Any]]:
        def graphql(_query: str, variables: dict[str, Any]) -> dict[str, Any]:
            page = int(variables["cursor"] or 0)
            context = {
                "context": "CodeRabbit",
                "state": "SUCCESS",
                "description": "Review rate limited" if page == refused_on else "Review completed",
                "createdAt": "2026-09-30T17:02:29Z",
                "creator": {"login": "coderabbitai"},
            }
            commit = {"oid": f"{page:040d}", "status": {"contexts": [context]}}
            return {
                "repository": {
                    "pullRequests": {
                        "pageInfo": {"hasNextPage": page + 1 < count, "endCursor": str(page + 1)},
                        "nodes": [{"number": page + 1, "commits": {"nodes": [{"commit": commit}]}}],
                    }
                }
            }

        return graphql

    def test_a_refused_head_on_a_later_page_is_read(self) -> None:
        gh = mock.Mock(graphql=self.pages(3, refused_on=2))
        heads = ADAPTER.open_heads(gh, REPO)
        self.assertEqual(len(heads), 3)
        self.assertEqual(ADAPTER.status_kind(heads[f"{2:040d}"][1]), "rate-limited")

    def test_more_open_pull_requests_than_the_bound_is_an_error(self) -> None:
        gh = mock.Mock(graphql=self.pages(ADAPTER.OPEN_PULL_PAGES + 1, refused_on=-1))
        with self.assertRaisesRegex(ADAPTER.WaitError, "cannot read every head"):
            ADAPTER.open_heads(gh, REPO)


class NewReviewTest(unittest.TestCase):
    """A trigger or an automatic start supersedes the completion evidence before it."""

    def processing(self, mode: str) -> Replay:
        # Synthetic: a new trigger after #1087's clean pass; CodeRabbit keeps the marker while it works.
        gh = Replay("1087", now="2026-09-30T10:30:06Z")
        gh.add_comment("1087", ADAPTER.TRIGGERS[mode], "2026-09-30T10:30:00Z")
        marker_line, rest = gh.comment("1087", SUMMARY_1087)["versions"][-1][1].split("\n", 1)
        gh.add_version("1087", SUMMARY_1087, f"{marker_line}\n> Currently processing new changes\n{rest}", "2026-09-30T10:30:05Z")
        return gh

    def test_a_clean_pass_followed_by_a_trigger_awaits_the_new_review(self) -> None:
        for mode in ("full", "incremental"):
            with self.subTest(mode=mode):
                gh = self.processing(mode)
                self.assertIsNotNone(observe(gh, "1087")["cleanReview"])
                self.assertEqual(observe(gh, "1087")["state"], "triggered")
                gh.add_status("1087", "Review in progress", "2026-09-30T10:30:12Z", state="pending")
                self.assertEqual(observed_at(gh, "1087", "2026-09-30T10:30:13Z")["state"], "in-progress")
                gh.add_status("1087", "Review completed", "2026-09-30T10:33:00Z")
                self.assertEqual(observed_at(gh, "1087", "2026-09-30T10:33:01Z")["state"], "clean-complete")

    def test_a_refusal_of_the_new_review_keeps_the_head_incomplete(self) -> None:
        gh = self.processing("full")
        gh.add_status("1087", "Review rate limited", "2026-09-30T10:30:07Z")
        result = observed_at(gh, "1087", "2026-09-30T10:31:00Z")
        self.assertIsNotNone(result["cleanReview"])
        self.assertEqual(result["state"], "rate-limited-unknown-wait")

    def test_run_does_not_complete_on_the_clean_pass_before_the_trigger(self) -> None:
        for mode in ("full", "incremental"):
            with self.subTest(mode=mode):
                gh = self.processing(mode)
                final, _reason, _value = run(gh, "1087", "2026-09-30T10:31:00Z", interval=5)
                self.assertEqual((final, gh.posts), ("triggered", []))

    def test_a_findings_review_followed_by_a_trigger_awaits_the_new_review(self) -> None:
        for mode in ("full", "incremental"):
            with self.subTest(mode=mode):
                gh = Replay("1040", now="2026-09-30T01:50:05Z")
                gh.add_comment("1040", ADAPTER.TRIGGERS[mode], "2026-09-30T01:50:00Z")
                self.assertEqual(observe(gh, "1040")["state"], "triggered")
                review = dict(gh.case("1040")["reviews"][0], id=2, submitted_at="2026-09-30T01:55:00Z")
                gh.case("1040")["reviews"].append(review)
                self.assertEqual(observed_at(gh, "1040", "2026-09-30T01:55:01Z")["state"], "review-complete")

    def test_a_completion_before_the_head_was_marked_ready_again_does_not_count(self) -> None:
        gh = Replay("1087", now="2026-09-30T10:30:30Z")
        gh.case("1087")["readyAt"] = "2026-09-30T10:30:00Z"  # Synthetic: marked ready again.
        self.assertEqual(observe(gh, "1087")["state"], "awaiting-automatic")


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

    def test_a_check_suite_on_another_branch_does_not_date_the_head(self) -> None:
        gh = Replay("1043", now="2026-09-30T17:20:00Z")
        gh.add_suite("1043", "2026-09-30T16:00:00Z", "another-branch")
        gh.add_comment("1043", "@coderabbitai review", "2026-09-30T16:10:00Z")
        result = observe(gh, "1043")
        self.assertEqual(result["headArrival"], {"at": "2026-09-30T16:16:59Z", "source": "check-suite"})
        self.assertEqual(result["triggers"], [])


class EscalationTest(unittest.TestCase):
    """An unconfirmed completion gets one full review per head, then blocks.

    Synthetic: #1083 merged at 07:57:44, before the Review completed statuses
    these replays read, and is replayed open.
    """

    def replay(self, now: str) -> Replay:
        return Replay("1083", now=now)

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


class RunTest(unittest.TestCase):
    def test_recorded_1043_triggers_once_exactly_when_the_wait_ends(self) -> None:
        gh = Replay("1043", now="2026-09-30T17:05:00Z")
        answering(gh, "1043")
        final, _reason, value = run(gh, "1043", "2026-09-30T17:30:00Z")
        self.assertEqual(len(gh.posts), 1)
        endpoint, fields, when = gh.posts[0]
        self.assertEqual(endpoint, f"repos/{REPO}/issues/1043/comments")
        self.assertEqual(fields, {"body": "@coderabbitai review"})
        self.assertEqual(iso(when), "2026-09-30T17:15:28Z")
        self.assertEqual(final, "blocked-unanswered")
        self.assertEqual(iso(gh.now), "2026-09-30T17:25:28Z")
        self.assertEqual(value["triggers"][0]["commentId"], gh.case("1043")["comments"][-1]["id"])

    def test_a_run_started_during_the_automatic_review_does_not_post_before_it(self) -> None:
        # Recorded: a run at 17:02:15 posted a trigger; CodeRabbit's own review started at 17:02:23.
        gh = Replay("1043", now="2026-09-30T17:02:15Z")
        answering(gh, "1043")
        final, _reason, _value = run(gh, "1043", "2026-09-30T17:30:00Z", interval=5)
        self.assertEqual([iso(when) for _endpoint, _fields, when in gh.posts], ["2026-09-30T17:15:28Z"])
        self.assertEqual(final, "blocked-unanswered")

    def test_run_escalates_an_unconfirmed_completion_to_one_full_review(self) -> None:
        gh = Replay("1043", now="2026-09-30T17:20:00Z")

        def completes(posted: float) -> None:
            gh.add_status("1043", "Review in progress", iso(posted + 10), state="pending")
            gh.add_status("1043", "Review completed", iso(posted + 40))

        answering(gh, "1043", completes, completes)
        final, _reason, value = run(gh, "1043", "2026-09-30T18:00:00Z")
        self.assertEqual(
            [fields["body"] for _endpoint, fields, _when in gh.posts],
            ["@coderabbitai review", "@coderabbitai full review"],
        )
        self.assertEqual([trigger["mode"] for trigger in value["triggers"]], ["incremental", "full"])
        self.assertEqual(final, "blocked-unconfirmed")

    def test_run_waits_out_a_refusal_then_retries(self) -> None:
        gh = Replay("1043", now="2026-09-30T17:20:00Z")
        summary = ADAPTER.SUMMARY_MARKER + "\n> Next included review available in 5 minutes."

        def refuses(posted: float) -> None:
            gh.add_status("1043", "Review in progress", iso(posted + 10), state="pending")
            gh.add_version("1043", SUMMARY_1043, summary, iso(posted + 15))
            gh.add_status("1043", "Review rate limited", iso(posted + 16))

        def reviews(posted: float) -> None:
            gh.add_status("1043", "Review in progress", iso(posted + 10), state="pending")
            gh.case("1043")["reviews"].append(
                {
                    "id": 1,
                    "user": {"login": "coderabbitai[bot]"},
                    "body": "**Actionable comments posted: 2**",
                    "state": "COMMENTED",
                    "commit_id": gh.case("1043")["head"],
                    "submitted_at": iso(posted + 200),
                }
            )
            gh.add_status("1043", "Review completed", iso(posted + 205))

        answering(gh, "1043", refuses, reviews)
        final, _reason, _value = run(gh, "1043", "2026-09-30T18:00:00Z")
        self.assertEqual(
            [(fields["body"], iso(when)) for _endpoint, fields, when in gh.posts],
            [("@coderabbitai review", "2026-09-30T17:20:00Z"), ("@coderabbitai review", "2026-09-30T17:26:15Z")],
        )
        self.assertEqual(final, "review-complete")

    def test_a_full_trigger_in_the_same_second_as_a_completed_status_awaits_its_answer(self) -> None:
        gh = Replay("1043", now="2026-09-30T17:20:00Z")
        gh.add_status("1043", "Review completed", "2026-09-30T17:20:00Z")
        answering(gh, "1043")
        final, _reason, _value = run(gh, "1043", "2026-09-30T17:20:30Z", interval=1)
        self.assertEqual(
            [(fields["body"], iso(when)) for _endpoint, fields, when in gh.posts],
            [("@coderabbitai full review", "2026-09-30T17:20:00Z")],
        )
        self.assertEqual(final, "triggered")

    def test_a_trigger_in_the_same_second_as_a_draft_skip_is_posted_once(self) -> None:
        gh = Replay("1043", now="2026-09-30T17:20:00Z")
        gh.add_status("1043", "Review skipped: draft pull request", "2026-09-30T17:20:00Z")
        answering(gh, "1043")
        final, _reason, _value = run(gh, "1043", "2026-09-30T17:20:30Z", interval=1)
        self.assertEqual([iso(when) for _endpoint, _fields, when in gh.posts], ["2026-09-30T17:20:00Z"])
        self.assertEqual(final, "triggered")

    def test_a_run_after_a_ready_event_waits_for_the_automatic_review(self) -> None:
        gh = Replay("1043", now="2026-09-30T17:20:00Z")
        gh.case("1043")["readyAt"] = "2026-09-30T17:19:55Z"  # Synthetic: marked ready again.
        gh.add_status("1043", "Review in progress", "2026-09-30T17:20:05Z", state="pending")
        answering(gh, "1043")
        final, _reason, _value = run(gh, "1043", "2026-09-30T17:21:00Z", interval=5)
        self.assertEqual((final, gh.posts), ("in-progress", []))

    def test_a_trigger_not_yet_listed_is_never_posted_twice(self) -> None:
        gh = Replay("1043", now="2026-09-30T17:20:00Z")
        final, _reason, _value = run(gh, "1043", "2026-09-30T17:30:00Z")
        self.assertEqual(len(gh.posts), 1)
        self.assertEqual(final, "trigger-incremental")

    def test_an_unknown_wait_is_polled_then_blocks_and_never_triggers(self) -> None:
        gh = Replay("1043", now="2026-09-30T17:05:00Z")
        gh.move_version("1043", SUMMARY_1043, "2026-09-30T17:02:28Z", "2026-09-30T17:00:00Z")
        final, _reason, value = run(gh, "1043", "2026-09-30T19:00:00Z")
        self.assertEqual(final, "blocked-unknown-wait")
        self.assertEqual(gh.posts, [])
        self.assertEqual(iso(gh.now), "2026-09-30T17:17:29Z")
        self.assertEqual(value["pullRequests"][0]["since"], "2026-09-30T17:02:29Z")

    def test_an_unknown_wait_ends_when_a_new_status_arrives(self) -> None:
        gh = Replay("1043", now="2026-09-30T17:05:00Z")
        gh.move_version("1043", SUMMARY_1043, "2026-09-30T17:02:28Z", "2026-09-30T17:00:00Z")
        gh.add_status("1043", "Review in progress", "2026-09-30T17:10:00Z", state="pending")
        gh.add_status("1043", "Review skipped: 474 files exceed the limit of 150", "2026-09-30T17:11:00Z")
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
        for blocked in sorted(ADAPTER.BLOCKED_STATES):
            with self.subTest(state=blocked):
                self.assertEqual(aggregate("waiting", blocked), "blocked")
        for pending in ("rate-limited-unknown-wait", "waiting-account-unknown", "awaiting-automatic", "triggered"):
            with self.subTest(state=pending):
                self.assertEqual(aggregate("review-complete", pending), "pending")

    def test_a_command_never_reports_a_state_it_does_not_declare(self) -> None:
        metrics = ADAPTER.Metrics(0.0)
        with self.assertRaises(ADAPTER.WaitError):
            ADAPTER.envelope("status", "lock-held", {}, {}, metrics, "")
        with self.assertRaises(ADAPTER.WaitError):
            ADAPTER.envelope("run", "satisfied", {}, {}, metrics, "")
        self.assertEqual(ADAPTER.envelope("run", "pending", {}, {}, metrics, "")["state"], "pending")
        self.assertLessEqual(ADAPTER.FINAL_STATES, ADAPTER.HEAD_STATES)

    def test_the_docs_list_every_state_with_the_commands_that_report_it(self) -> None:
        text = (ROOT / "address-feedback" / "references" / "pr-readiness.md").read_text()
        section = text.split("\n## CodeRabbit\n", 1)[1].split("\n## ", 1)[0]
        documented: dict[str, frozenset[str]] = {}
        for line in section.splitlines():
            cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
            if not line.startswith("|") or len(cells) != 3 or not cells[0].startswith("`"):
                continue
            commands = frozenset(re.findall(r"`([a-z]+)`", cells[1]))
            for name in re.findall(r"`([a-z-]+)`", cells[0]):
                self.assertNotIn(name, documented, f"{name} is listed twice")
                documented[name] = commands
        self.assertEqual(documented, ADAPTER.STATE_COMMANDS)


if __name__ == "__main__":
    unittest.main()
