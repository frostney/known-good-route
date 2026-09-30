#!/usr/bin/env python3
"""Deterministic CodeRabbit review trigger, wait and completion adapter.

This script is the only definition of how CodeRabbit is triggered, waited
for, and judged complete. Every decision reads sources bound to the exact
head commit:

- CodeRabbit's commit statuses on the head, newest first;
- CodeRabbit review objects whose `commit_id` is the head;
- the summary comment's coverage marker naming the head;
- the summary comment version CodeRabbit edited in just before a rate-limit
  status, which carries the only stated retry time;
- when the head arrived, the pull request was opened, and it was last marked
  ready, after which CodeRabbit starts its own review; and
- CodeRabbit's newest status on the head of every open pull request in the
  scanned repositories, which holds a trigger on the account.

Completion evidence counts only when it is newer than the latest trigger and
the latest event after which CodeRabbit starts its own review. Every state
that waits on CodeRabbit ends after a fixed bound: the wait for its own
review becomes a trigger, and an unanswered trigger, a stalled review and an
unexplained refusal each become a blocked state.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, TextIO

sys.dont_write_bytecode = True  # Keep installed skill trees free of __pycache__.

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "delivery-wait" / "scripts"))

from kgr_github import (  # noqa: E402
    Gh,
    Metrics,
    RateLimited,
    TransientError,
    WaitError,
    emit,
    parse_time,
    positive_interval,
    result_envelope,
    stable_digest,
)


BOT_LOGINS = {"coderabbitai", "coderabbitai[bot]"}
TRIGGERS = {
    "incremental": "@coderabbitai review",
    "full": "@coderabbitai full review",
}

# Commit-status descriptions CodeRabbit posts on a head (context "CodeRabbit").
STATUS_RATE_LIMITED = re.compile(r"^\s*review rate limited\b", re.IGNORECASE)
STATUS_COMPLETED = re.compile(r"^\s*review completed\b", re.IGNORECASE)
STATUS_DRAFT_SKIP = re.compile(r"^\s*review skipped:\s*draft pull request\b", re.IGNORECASE)
STATUS_SKIPPED = re.compile(r"^\s*review skipped\b", re.IGNORECASE)

# "Next included review available in 12 minutes." Older notices also said
# "please wait N minutes and M seconds".
STATED_WAIT = re.compile(
    r"(?:available in\D{0,10}|please wait\W{0,10})"
    r"(?:(\d+)\s*minutes?(?:\D{0,10}(\d+)\s*seconds?)?|(\d+)\s*seconds?)",
    re.IGNORECASE,
)

# A findings review names its findings in its body.
ACTIONABLE = re.compile(r"Actionable comments posted:\s*(\d+)", re.IGNORECASE)
REVIEW_FINDINGS = re.compile(
    r"(?:Outside diff range|Nitpick|Duplicate) comments \(\d+\)", re.IGNORECASE
)

# The first line of every version of CodeRabbit's summary comment. Its replies
# to commands start "<!-- This is an auto-generated reply by CodeRabbit -->".
SUMMARY_MARKER = "<!-- This is an auto-generated comment: summarize by coderabbit.ai -->"

# The summary comment marks the commit its latest review covered:
# <!-- final_review_risk_coverage:{"sourceCommitId":..,"coveredCommitId":..,"kind":"reviewed"} -->
COVERAGE_MARKER = re.compile(r"final_review_risk_coverage:(\{[^{}]*\})")
NO_ACTIONABLE = "No actionable comments were generated"

UNAVAILABLE_SOURCE = re.compile(r"\(HTTP 40[34]\)")

# CodeRabbit edits the stated wait into its summary comment 0-36 s before it
# posts the rate-limit status (75 of 75 recorded refusals); 60 s bounds the
# pairing.
CORRELATION_SECONDS = 60
# CodeRabbit states waits in whole minutes, so a stated time can be a minute early.
WAIT_BUFFER_SECONDS = 60
# Where CodeRabbit reviewed a head unprompted, its first status came within
# 38 s of the push and 16 s of the pull request being opened or marked ready.
AUTOMATIC_REVIEW_SECONDS = 120
# Recorded triggers got a status within 20 s, or 316 s behind a review already
# in progress.
TRIGGER_ANSWER_SECONDS = 10 * 60
# The longest recorded review in progress ended after 700 s.
IN_PROGRESS_SECONDS = 60 * 60
# How long a refusal without a paired stated wait holds triggers while
# CodeRabbit shows no review or stated wait after it.
UNKNOWN_WAIT_SECONDS = 15 * 60
EDIT_HISTORY_PAGES = 10
OPEN_PULL_PAGES = 10

COMMENT_EDITS_QUERY = """query($id: ID!, $cursor: String) {
  node(id: $id) { ... on IssueComment {
    userContentEdits(first: 20, after: $cursor) {
      pageInfo { hasNextPage endCursor } nodes { editedAt diff }
    }
  } }
}"""
READY_QUERY = """query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    timelineItems(last: 1, itemTypes: [READY_FOR_REVIEW_EVENT]) {
      nodes { ... on ReadyForReviewEvent { createdAt } }
    }
  } }
}"""
# A commit's `status.contexts` holds the newest status of each context.
OPEN_PULLS_QUERY = """query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { number commits(last: 1) { nodes { commit { oid status { contexts {
        context state description createdAt creator { login }
      } } } } } }
    }
  }
}"""

# Every state a command reports, and the commands that report it. `status`
# reports one state per head and one for the whole set; `run` reports its
# head's state, which is a pending one when its deadline arrives first.
HEAD_STATES = frozenset(
    {
        "review-complete",
        "clean-complete",
        "trigger-incremental",
        "trigger-full",
        "awaiting-automatic",
        "triggered",
        "in-progress",
        "waiting",
        "rate-limited-unknown-wait",
        "waiting-account-unknown",
        "draft",
        "skipped",
        "blocked-unanswered",
        "blocked-stalled",
        "blocked-unknown-wait",
        "blocked-account-unknown-wait",
        "blocked-unconfirmed",
        "unrecognized-status",
        "closed",
        "invalidated",
    }
)
STATE_COMMANDS: dict[str, frozenset[str]] = {
    **{state: frozenset({"run", "status"}) for state in HEAD_STATES},
    "satisfied": frozenset({"status"}),
    "blocked": frozenset({"status"}),
    "pending": frozenset({"run", "status"}),
    "lock-held": frozenset({"run"}),
    "operational-error": frozenset({"run", "status"}),
}

# `run` stops at a final state; it waits on the others until its deadline.
COMPLETE_STATES = frozenset({"review-complete", "clean-complete"})
BLOCKED_STATES = frozenset(
    {
        "skipped",
        "blocked-unanswered",
        "blocked-stalled",
        "blocked-unknown-wait",
        "blocked-account-unknown-wait",
        "blocked-unconfirmed",
        "unrecognized-status",
        "closed",
    }
)
FINAL_STATES = COMPLETE_STATES | BLOCKED_STATES | {"draft", "invalidated"}


def repo_parts(repo: str) -> tuple[str, str]:
    pieces = repo.split("/", 1)
    if len(pieces) != 2 or not all(pieces):
        raise WaitError("repository must be OWNER/REPO")
    return pieces[0], pieces[1]


def positive_pr(value: int) -> int:
    if value <= 0:
        raise WaitError("pull-request numbers must be positive")
    return value


def parse_timestamp(value: Any, label: str) -> float:
    if not isinstance(value, str) or not value:
        raise WaitError(f"CodeRabbit evidence is missing {label}")
    return parse_time(value)


def format_timestamp(value: float) -> str:
    return datetime.fromtimestamp(value, timezone.utc).isoformat().replace("+00:00", "Z")


def login_of(item: dict[str, Any], field: str = "user") -> str:
    return str((item.get(field) or {}).get("login") or "").lower()


def is_bot(item: dict[str, Any], field: str = "user") -> bool:
    return login_of(item, field) in BOT_LOGINS


def rest_items(gh: Gh, endpoint: str) -> list[dict[str, Any]]:
    pages = gh.rest_pages(endpoint)
    items: list[dict[str, Any]] = []
    for page in pages:
        if not isinstance(page, list) or not all(isinstance(item, dict) for item in page):
            raise WaitError(f"paginated GitHub response for {endpoint} is invalid")
        items.extend(page)
    return items


def optional_items(fetch: Callable[[], list[Any]]) -> list[Any]:
    """Items from a source the repository may not expose; 403 and 404 yield none."""
    try:
        return fetch()
    except (RateLimited, TransientError):
        raise
    except WaitError as error:
        if UNAVAILABLE_SOURCE.search(str(error)):
            return []
        raise


def stated_seconds(body: str) -> int | None:
    match = STATED_WAIT.search(body)
    if not match:
        return None
    minutes, seconds, only_seconds = (int(group or 0) for group in match.groups())
    return minutes * 60 + seconds + only_seconds


# --- Head statuses ---------------------------------------------------------


def is_coderabbit(status: dict[str, Any]) -> bool:
    return "coderabbit" in str(status.get("context") or "").lower() and is_bot(status, "creator")


def coderabbit_statuses(gh: Gh, repo: str, sha: str) -> list[dict[str, Any]]:
    """CodeRabbit's statuses on one commit, oldest first."""
    statuses = [
        status
        for status in rest_items(gh, f"repos/{repo}/commits/{sha}/statuses?per_page=100")
        if is_coderabbit(status)
    ]
    return sorted(
        statuses,
        key=lambda status: (
            parse_timestamp(status.get("created_at"), "status created_at"),
            int(status.get("id") or 0),
        ),
    )


def status_kind(status: dict[str, Any] | None) -> str:
    if status is None:
        return "none"
    state = str(status.get("state") or "").lower()
    description = str(status.get("description") or "")
    if state == "pending":
        return "in-progress"
    if state == "success":
        if STATUS_RATE_LIMITED.search(description):
            return "rate-limited"
        if STATUS_COMPLETED.search(description):
            return "completed"
        if STATUS_DRAFT_SKIP.search(description):
            return "draft-skip"
        if STATUS_SKIPPED.search(description):
            return "skipped"
    return "unrecognized"


def status_summary(status: dict[str, Any] | None) -> dict[str, Any] | None:
    if status is None:
        return None
    return {
        "id": status.get("id"),
        "state": status.get("state"),
        "description": status.get("description"),
        "createdAt": status.get("created_at"),
        "kind": status_kind(status),
    }


# --- Stated waits ------------------------------------------------------------


def comment_versions(
    gh: Gh, item: dict[str, Any], since: float
) -> tuple[list[tuple[float, str]], bool]:
    """Every body the comment showed from `since` on, each with when it was set.

    An unedited comment has one version, its creation. An edited one has its
    edit history, newest first, where each entry is the full body from its
    `editedAt`. Returns the versions and whether the history was read back to
    `since`.
    """
    body = str(item.get("body") or "")
    created = parse_timestamp(item.get("created_at"), "comment created_at")
    updated = parse_timestamp(item.get("updated_at"), "comment updated_at")
    if updated <= created:
        return [(created, body)], True
    versions: list[tuple[float, str]] = [(updated, body)]
    node_id = item.get("node_id")
    if not isinstance(node_id, str) or not node_id:
        return versions, False
    cursor: str | None = None
    for _page in range(EDIT_HISTORY_PAGES):
        try:
            data = gh.graphql(COMMENT_EDITS_QUERY, {"id": node_id, "cursor": cursor})
        except (RateLimited, TransientError):
            raise
        except WaitError:
            return versions, False
        edits = ((data or {}).get("node") or {}).get("userContentEdits") or {}
        times: list[float] = []
        for node in edits.get("nodes") or []:
            if not isinstance(node, dict):
                continue
            at = parse_timestamp(node.get("editedAt"), "edit editedAt")
            times.append(at)
            if isinstance(node.get("diff"), str):
                versions.append((at, node["diff"]))
        page = edits.get("pageInfo") or {}
        descending = times == sorted(times, reverse=True)
        if not page.get("hasNextPage") or (times and descending and times[-1] < since):
            return versions, True
        cursor = page.get("endCursor")
    return versions, False


def is_summary(item: dict[str, Any]) -> bool:
    return is_bot(item) and str(item.get("body") or "").lstrip().startswith(SUMMARY_MARKER)


def correlated_wait(
    gh: Gh, comments: list[dict[str, Any]], status_at: float
) -> tuple[dict[str, Any] | None, str | None]:
    """The stated wait CodeRabbit edited in for a rate-limit status at `status_at`.

    Only summary-comment versions set within CORRELATION_SECONDS at or before
    the status count; when several state a wait, the latest retry time wins.
    Returns the wait, or None and why there is none.
    """
    start = status_at - CORRELATION_SECONDS
    best: tuple[float, float, int, dict[str, Any]] | None = None
    for item in comments:
        if not is_summary(item):
            continue
        if parse_timestamp(item.get("updated_at"), "comment updated_at") < start:
            continue
        versions, read = comment_versions(gh, item, start)
        if not read:
            return None, (
                f"the edit history of summary comment {item.get('id')} could not be read "
                f"back to {format_timestamp(start)}"
            )
        for at, body in versions:
            seconds = stated_seconds(body)
            if seconds is None or not start <= at <= status_at:
                continue
            if best is None or at + seconds > best[0]:
                best = (at + seconds, at, seconds, item)
    if best is None:
        return None, (
            f"no summary-comment version stating a wait was set within {CORRELATION_SECONDS} s "
            "before the status"
        )
    available, at, seconds, item = best
    return (
        {
            "commentId": item.get("id"),
            "editedAt": format_timestamp(at),
            "statedSeconds": seconds,
            "availableAt": format_timestamp(available),
            "retryAt": format_timestamp(available + WAIT_BUFFER_SECONDS),
            "retryAtEpoch": available + WAIT_BUFFER_SECONDS,
            "statusAt": format_timestamp(status_at),
        },
        None,
    )


def refusal(
    gh: Gh, head: dict[str, Any], status: dict[str, Any], comments: list[dict[str, Any]]
) -> dict[str, Any]:
    """A rate-limit status on a head, with the stated wait paired to it or why there is none."""
    at = parse_timestamp(status.get("created_at"), "status created_at")
    wait, missing = correlated_wait(gh, comments, at)
    return head | {"statusAt": format_timestamp(at), "at": at, "wait": wait, "missing": missing}


def open_heads(gh: Gh, repo: str) -> dict[str, tuple[list[int], dict[str, Any] | None]]:
    """Each open pull request's head, with its PRs and CodeRabbit's newest status on it."""
    owner, name = repo_parts(repo)
    heads: dict[str, tuple[list[int], dict[str, Any] | None]] = {}
    cursor: str | None = None
    for _page in range(OPEN_PULL_PAGES):
        data = gh.graphql(OPEN_PULLS_QUERY, {"owner": owner, "name": name, "cursor": cursor})
        pulls = ((data or {}).get("repository") or {}).get("pullRequests") or {}
        for node in pulls.get("nodes") or []:
            commits = ((node or {}).get("commits") or {}).get("nodes") or []
            commit = ((commits[-1] if commits else None) or {}).get("commit") or {}
            oid = commit.get("oid")
            if not isinstance(oid, str) or not isinstance(node.get("number"), int):
                raise WaitError(f"an open pull request in {repo} is missing its number or head")
            statuses = [
                context | {"created_at": context.get("createdAt")}
                for context in ((commit.get("status") or {}).get("contexts") or [])
                if is_coderabbit(context)
            ]
            newest = max(
                statuses,
                key=lambda item: parse_timestamp(item["created_at"], "status createdAt"),
                default=None,
            )
            heads.setdefault(oid, ([], newest))[0].append(node["number"])
        page = pulls.get("pageInfo") or {}
        if not page.get("hasNextPage"):
            return heads
        cursor = page.get("endCursor")
    raise WaitError(
        f"{repo} has more than {OPEN_PULL_PAGES * 100} open pull requests, so the account scan "
        "cannot read every head"
    )


def account_statuses(gh: Gh, repos: list[str]) -> dict[str, Any]:
    """CodeRabbit's newest status on every open head in the scanned repositories.

    Returns each head it last refused with a rate limit, and the newest of
    these statuses reporting a review in progress or completed.
    """
    refusals: list[dict[str, Any]] = []
    recoveries: list[float] = []
    for repo in repos:
        for sha, (prs, status) in open_heads(gh, repo).items():
            kind = status_kind(status)
            if kind in {"in-progress", "completed"}:
                recoveries.append(parse_timestamp(status["created_at"], "status createdAt"))
            elif kind == "rate-limited":
                comments = [
                    item
                    for pr in prs
                    for item in rest_items(gh, f"repos/{repo}/issues/{pr}/comments?per_page=100")
                ]
                refusals.append(refusal(gh, {"repo": repo, "prs": prs, "sha": sha}, status, comments))
    return {"refusals": refusals, "reviewedAt": max(recoveries, default=None)}


# --- Completion ----------------------------------------------------------------


def findings_review(reviews: list[dict[str, Any]], head: str) -> dict[str, Any] | None:
    """The newest CodeRabbit review of exactly `head` that states findings."""
    found = []
    for review in reviews:
        body = str(review.get("body") or "")
        actionable = ACTIONABLE.search(body)
        evidence = bool(actionable and int(actionable.group(1)) >= 1) or bool(
            REVIEW_FINDINGS.search(body)
        )
        if is_bot(review) and review.get("commit_id") == head and evidence:
            found.append(
                {
                    "id": review.get("id"),
                    "submittedAt": review.get("submitted_at"),
                    "actionable": int(actionable.group(1)) if actionable else None,
                }
            )
    return max(found, key=lambda item: str(item["submittedAt"]), default=None)


def coverage(body: str) -> dict[str, Any] | None:
    match = COVERAGE_MARKER.search(body)
    if not match:
        return None
    try:
        value = json.loads(match.group(1))
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def clean_review(bot_comments: list[dict[str, Any]], head: str) -> dict[str, Any] | None:
    """A clean pass of exactly `head`: its coverage marker and no actionable comments."""
    for item in bot_comments:
        body = str(item.get("body") or "")
        marker = coverage(body)
        if (
            marker
            and marker.get("coveredCommitId") == head
            and marker.get("kind") == "reviewed"
            and NO_ACTIONABLE in body
        ):
            return {"commentId": item.get("id"), "coveredCommitId": head}
    return None


# --- Triggers ----------------------------------------------------------------


def head_arrival(
    gh: Gh, repo: str, pull: dict[str, Any], head: str, statuses: list[dict[str, Any]]
) -> tuple[float, str]:
    """When the head reached the PR branch, and the evidence for it.

    GitHub creates check suites for a pushed commit on its branch at push
    time. Without one, CodeRabbit's first status on the head, which follows
    the push; without that, the commit time, which precedes it.
    """
    head_ref = (pull.get("head") or {}).get("ref")
    pages = optional_items(
        lambda: gh.rest_pages(f"repos/{repo}/commits/{head}/check-suites?per_page=100")
    )
    created = [
        parse_timestamp(suite.get("created_at"), "check suite created_at")
        for page in pages
        if isinstance(page, dict)
        for suite in page.get("check_suites") or []
        if isinstance(suite, dict) and suite.get("head_branch") == head_ref
    ]
    if created:
        return min(created), "check-suite"
    if statuses:
        return parse_timestamp(statuses[0].get("created_at"), "status created_at"), "status"
    commit = gh.rest(f"repos/{repo}/commits/{head}")
    committed = (((commit or {}).get("commit") or {}).get("committer") or {}).get("date")
    return parse_timestamp(committed, "head commit time"), "commit"


def automatic_review_start(
    gh: Gh, repo: str, pr: int, pull: dict[str, Any], arrival: tuple[float, str]
) -> tuple[float, str]:
    """The latest event after which CodeRabbit starts its own review of the head.

    It reviews a head when it is pushed, when the pull request is opened, and
    when the pull request is marked ready for review.
    """
    owner, name = repo_parts(repo)
    data = gh.graphql(READY_QUERY, {"owner": owner, "name": name, "number": pr})
    pull_request = ((data or {}).get("repository") or {}).get("pullRequest") or {}
    nodes = ((pull_request.get("timelineItems") or {}).get("nodes")) or []
    events = [arrival, (parse_timestamp(pull.get("created_at"), "pull request created_at"), "opened")]
    events += [
        (parse_timestamp(node.get("createdAt"), "ready-for-review createdAt"), "ready-for-review")
        for node in nodes
        if isinstance(node, dict)
    ]
    return max(events, key=lambda event: event[0])


def head_triggers(comments: list[dict[str, Any]], arrival: float) -> list[dict[str, Any]]:
    """Trigger commands posted on the PR since the head arrived, oldest first."""
    modes = {body: mode for mode, body in TRIGGERS.items()}
    found = []
    for item in comments:
        mode = modes.get(str(item.get("body") or "").strip().lower())
        if mode is None or is_bot(item):
            continue
        created = parse_timestamp(item.get("created_at"), "trigger created_at")
        if created >= arrival:
            found.append(
                {"id": item.get("id"), "mode": mode, "createdAt": item["created_at"], "at": created}
            )
    return sorted(found, key=lambda trigger: (trigger["at"], int(trigger["id"] or 0)))


# --- Evidence and decision ------------------------------------------------------


def pull_evidence(gh: Gh, repo: str, pr: int) -> dict[str, Any]:
    repo_parts(repo)
    pr = positive_pr(pr)
    pull = gh.rest(f"repos/{repo}/pulls/{pr}")
    if not isinstance(pull, dict):
        raise WaitError(f"pull request {repo}#{pr} response is invalid")
    head = (pull.get("head") or {}).get("sha")
    if not isinstance(head, str) or not head:
        raise WaitError(f"pull request {repo}#{pr} is missing its head SHA")
    statuses = coderabbit_statuses(gh, repo, head)
    newest = statuses[-1] if statuses else None
    comments = rest_items(gh, f"repos/{repo}/issues/{pr}/comments?per_page=100")
    reviews = rest_items(gh, f"repos/{repo}/pulls/{pr}/reviews?per_page=100")
    bot_comments = [item for item in comments if is_bot(item)]
    arrival, arrival_source = head_arrival(gh, repo, pull, head, statuses)
    automatic, automatic_source = automatic_review_start(
        gh, repo, pr, pull, (arrival, f"head-{arrival_source}")
    )
    rate_limit = None
    if status_kind(newest) == "rate-limited":
        rate_limit = refusal(gh, {"repo": repo, "prs": [pr], "sha": head}, newest, bot_comments)
    return {
        "repo": repo,
        "pr": pr,
        "head": head,
        "open": pull.get("state") == "open",
        "draft": bool(pull.get("draft")),
        "headArrival": {"at": format_timestamp(arrival), "source": arrival_source},
        "automaticReview": {"from": format_timestamp(automatic), "source": automatic_source},
        "status": status_summary(newest),
        "findingsReview": findings_review(reviews, head),
        "cleanReview": clean_review(bot_comments, head),
        "triggers": head_triggers(comments, arrival),
        "rateLimit": rate_limit,
    }


def decide(
    evidence: dict[str, Any], expected_head: str, account: dict[str, Any], now: float
) -> dict[str, Any]:
    """The head's state, why, the trigger mode to post, and when it can change."""

    def result(state: str, reason: str, mode: str | None = None, **extra: Any) -> dict[str, Any]:
        if state not in HEAD_STATES:
            raise WaitError(f"CodeRabbit adapter produced an undeclared state {state!r}")
        return {"state": state, "reason": reason, "nextMode": mode, "retryAt": None} | extra

    def bounded(
        pending: str,
        blocked: str,
        since: float,
        seconds: int,
        why: str,
        mode: str | None = None,
        **extra: Any,
    ) -> dict[str, Any]:
        """`pending` for `seconds` after `since`, then `blocked`."""
        bound = since + seconds
        timing = {"since": format_timestamp(since), "boundAt": format_timestamp(bound)} | extra
        if now < bound:
            return result(pending, f"{why}; {blocked} at {timing['boundAt']}", mode, **timing)
        return result(blocked, f"{why} and nothing changed for {seconds // 60} minutes", **timing)

    def gate(mode: str) -> dict[str, Any]:
        """Hold the trigger while any open head's refusal still applies to the account."""
        own = evidence["rateLimit"]
        by_head = {(item["repo"], item["sha"]): item for item in account["refusals"]}
        if own:
            by_head[(own["repo"], own["sha"])] = own
        paired = [item for item in by_head.values() if item["wait"]]
        # A later review or paired refusal on the account shows CodeRabbit recovered.
        recovered = max([item["at"] for item in paired] + [account["reviewedAt"] or 0.0])
        unknown = [item for item in by_head.values() if not item["wait"] and item["at"] >= recovered]
        if unknown:
            oldest = min(unknown, key=lambda item: item["at"])
            prs = ", ".join(f"#{pr}" for pr in oldest["prs"])
            names = (
                ("rate-limited-unknown-wait", "blocked-unknown-wait")
                if oldest is own
                else ("waiting-account-unknown", "blocked-account-unknown-wait")
            )
            return bounded(
                *names,
                oldest["at"],
                UNKNOWN_WAIT_SECONDS,
                f"CodeRabbit rate-limited {oldest['repo']} {prs} at {oldest['statusAt']} and "
                f"{oldest['missing']}, and has shown no review or stated wait since",
                mode,
                unmatchedRateLimit=public_refusal(oldest),
            )
        pending = [item for item in paired if item["wait"]["retryAtEpoch"] > now]
        if pending:
            latest_wait = max(pending, key=lambda item: item["wait"]["retryAtEpoch"])
            prs = ", ".join(f"#{pr}" for pr in latest_wait["prs"])
            return result(
                "waiting",
                f"CodeRabbit stated a wait on {latest_wait['repo']} {prs} that ends at "
                f"{latest_wait['wait']['retryAt']}",
                mode,
                retryAt=latest_wait["wait"]["retryAt"],
                retrySource="pull-request" if latest_wait is own else "account",
            )
        return result(f"trigger-{mode}", f"a {mode} review trigger is permitted", mode)

    def answer(trigger: dict[str, Any]) -> dict[str, Any]:
        return bounded(
            "triggered",
            "blocked-unanswered",
            trigger["at"],
            TRIGGER_ANSWER_SECONDS,
            f"the {trigger['mode']} trigger posted at {trigger['createdAt']} awaits a CodeRabbit status",
        )

    if evidence["head"] != expected_head:
        return result("invalidated", f"expected head {expected_head}, observed {evidence['head']}")
    if not evidence["open"]:
        return result("closed", "the pull request is closed")
    status = evidence["status"]
    kind = status["kind"] if status else "none"
    status_at = parse_timestamp(status["createdAt"], "status createdAt") if status else None
    if kind == "in-progress":
        return bounded(
            "in-progress",
            "blocked-stalled",
            status_at,
            IN_PROGRESS_SECONDS,
            f"CodeRabbit has reported a review in progress on the head since {status['createdAt']}",
        )

    triggers = evidence["triggers"]
    latest = triggers[-1] if triggers else None
    automatic = evidence["automaticReview"]
    start = parse_timestamp(automatic["from"], "automatic review start")
    # A trigger or an automatic start begins a new review; evidence from before it is superseded.
    begun = max(start, latest["at"]) if latest else start
    review = evidence["findingsReview"]
    if review and parse_timestamp(review["submittedAt"], "review submitted_at") > begun:
        return result("review-complete", "a CodeRabbit review of exactly this head states findings")
    # CodeRabbit keeps the marker while it reviews again; the completed status dates the pass.
    if evidence["cleanReview"] and kind == "completed" and status_at > begun:
        return result(
            "clean-complete",
            "CodeRabbit's summary marks this head covered with no actionable comments",
        )
    if kind in {"none", "draft-skip"} and evidence["draft"]:
        return result("draft", "CodeRabbit does not review a draft pull request")
    # No answer comes within a second of its trigger, so a status in that second predates it.
    if latest is not None and (status_at is None or latest["at"] >= status_at):
        return answer(latest)
    automatic_start = kind in {"none", "draft-skip"} or start > status_at
    if automatic_start and now < start + AUTOMATIC_REVIEW_SECONDS:
        return result(
            "awaiting-automatic",
            f"CodeRabbit may still start its own review after {automatic['source']} at "
            f"{automatic['from']}; a trigger is permitted from "
            f"{format_timestamp(start + AUTOMATIC_REVIEW_SECONDS)}",
            since=automatic["from"],
            boundAt=format_timestamp(start + AUTOMATIC_REVIEW_SECONDS),
        )
    if kind in {"none", "draft-skip"}:
        return gate("incremental")
    if kind == "skipped":
        return result("skipped", f"CodeRabbit skipped the head: {status['description']}")
    if kind == "rate-limited":
        return gate(latest["mode"] if latest else "incremental")
    if kind == "completed":
        if any(trigger["mode"] == "full" for trigger in triggers):
            return result(
                "blocked-unconfirmed",
                "CodeRabbit reported the head's review completed without a review or "
                "coverage marker for it, after a full review was requested",
            )
        return gate("full")
    return result(
        "unrecognized-status",
        f"unrecognized CodeRabbit status: {status['state']} {status['description']!r}",
    )


def public_refusal(item: dict[str, Any]) -> dict[str, Any]:
    """A refusal without internal epoch fields."""
    value = {key: entry for key, entry in item.items() if key != "at"}
    if item["wait"]:
        value["wait"] = {key: entry for key, entry in item["wait"].items() if key != "retryAtEpoch"}
    return value


def public(evidence: dict[str, Any]) -> dict[str, Any]:
    """Evidence without internal epoch fields."""
    value = dict(evidence)
    value["triggers"] = [
        {key: item[key] for key in ("id", "mode", "createdAt")} for item in evidence["triggers"]
    ]
    if evidence["rateLimit"]:
        value["rateLimit"] = public_refusal(evidence["rateLimit"])
    return value


class ObservationCache:
    """Serves each GitHub read once per observation; writes pass through."""

    def __init__(self, gh: Gh) -> None:
        self.gh = gh
        self.metrics = gh.metrics
        self.memo: dict[Any, Any] = {}

    def remember(self, key: Any, read: Callable[[], Any]) -> Any:
        if key not in self.memo:
            self.memo[key] = read()
        return self.memo[key]

    def rest_pages(self, endpoint: str) -> list[Any]:
        return self.remember(("pages", endpoint), lambda: self.gh.rest_pages(endpoint))

    def rest(self, endpoint: str, method: str = "GET", fields: dict[str, str] | None = None) -> Any:
        if method != "GET":
            return self.gh.rest(endpoint, method, fields)
        return self.remember(("rest", endpoint), lambda: self.gh.rest(endpoint))

    def graphql(self, query: str, variables: dict[str, Any]) -> Any:
        key = ("graphql", query, repr(sorted(variables.items())))
        return self.remember(key, lambda: self.gh.graphql(query, variables))


def observation(
    gh: Gh,
    repo: str,
    prs: list[int],
    expected_heads: dict[int, str],
    scan_repos: list[str],
    now: float,
) -> dict[str, Any]:
    gh = ObservationCache(gh)  # type: ignore[assignment]
    account = account_statuses(gh, scan_repos)
    results = []
    for pr in prs:
        evidence = pull_evidence(gh, repo, pr)
        results.append(public(evidence) | decide(evidence, expected_heads[pr], account, now))
    reviewed = account["reviewedAt"]
    return {
        "scanRepos": scan_repos,
        "account": {
            "refusals": [public_refusal(item) for item in account["refusals"]],
            "reviewedAt": format_timestamp(reviewed) if reviewed is not None else None,
        },
        "pullRequests": results,
    }


def aggregate_status(value: dict[str, Any]) -> tuple[str, str]:
    states = [item["state"] for item in value["pullRequests"]]
    if "invalidated" in states:
        return "invalidated", "at least one requested PR head changed"
    if all(state in COMPLETE_STATES for state in states):
        return "satisfied", "every requested head has a confirmed CodeRabbit review"
    if any(state in BLOCKED_STATES for state in states):
        return "blocked", "at least one requested head cannot get a CodeRabbit review without a person"
    return "pending", "at least one requested head still awaits a CodeRabbit transition"


# --- Account lock --------------------------------------------------------------


def lock_directory() -> Path:
    return Path(tempfile.gettempdir()) / "known-good-route-coderabbit"


def lock_path(login: str) -> Path:
    return lock_directory() / f"account-{stable_digest(login)[:16]}.lock"


def read_holder(handle: TextIO) -> dict[str, Any] | None:
    handle.seek(0)
    raw = handle.read().strip()
    if not raw:
        return None
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return {"unreadable": raw}
    return value if isinstance(value, dict) else {"unreadable": raw}


def lock_status(login: str) -> dict[str, Any]:
    """Whether a `run` holds the account lock, and which PR and head it serves."""
    path = lock_path(login)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+") as handle:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"path": str(path), "held": True, "holder": read_holder(handle)}
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    return {"path": str(path), "held": False, "holder": None}


def acquire_lock(
    login: str,
    holder: dict[str, Any],
    deadline: float,
    interval: float,
    *,
    clock: Callable[[], float] = time.time,
    sleeper: Callable[[float], None] = time.sleep,
) -> TextIO | None:
    path = lock_path(login)
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a+")
    while True:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            if clock() >= deadline:
                handle.close()
                return None
            sleeper(min(interval, max(0.0, deadline - clock())))
            continue
        handle.seek(0)
        handle.truncate()
        handle.write(
            json.dumps(
                holder | {"login": login, "pid": os.getpid(), "acquiredAt": format_timestamp(clock())},
                sort_keys=True,
            )
            + "\n"
        )
        handle.flush()
        return handle


def release_lock(handle: TextIO) -> None:
    handle.seek(0)
    handle.truncate()
    handle.flush()
    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    handle.close()


# --- Commands ----------------------------------------------------------------


def run_review(
    gh: Gh,
    repo: str,
    pr: int,
    head: str,
    scan_repos: list[str],
    deadline: float,
    interval: float,
    *,
    clock: Callable[[], float] = time.time,
    sleeper: Callable[[float], None] = time.sleep,
) -> tuple[str, str, dict[str, Any]]:
    """Trigger, wait and poll until the head reaches a final state or the deadline."""
    posted: list[dict[str, Any]] = []
    last: dict[str, Any] = {}
    while True:
        try:
            last = observation(gh, repo, [pr], {pr: head}, scan_repos, clock())
        except (RateLimited, TransientError):
            gh.metrics.retries += 1
            if clock() >= deadline:
                last["triggers"] = posted
                return "pending", "GitHub transport remained unavailable until the deadline", last
            sleeper(min(interval, max(0.0, deadline - clock())))
            continue
        last["triggers"] = posted
        item = last["pullRequests"][0]
        state, reason = item["state"], item["reason"]
        if state in FINAL_STATES:
            return state, reason, last
        seen = {trigger["id"] for trigger in item["triggers"]}
        unseen = [trigger for trigger in posted if trigger["commentId"] not in seen]
        if state.startswith("trigger-") and not unseen:
            if clock() >= deadline:
                return state, "deadline reached before the permitted trigger", last
            mode = item["nextMode"]
            created = gh.rest(f"repos/{repo}/issues/{pr}/comments", "POST", {"body": TRIGGERS[mode]})
            posted.append(
                {
                    "mode": mode,
                    "body": TRIGGERS[mode],
                    "commentId": (created or {}).get("id"),
                    "postedAt": format_timestamp(clock()),
                }
            )
        if clock() >= deadline:
            return state, f"deadline reached; {reason}", last
        # Wake when the state can next change: a stated wait ends or a bound passes.
        wakes = [interval, deadline - clock()]
        wakes += [parse_time(item[key]) - clock() for key in ("retryAt", "boundAt") if item.get(key)]
        sleeper(max(0.0, min(wakes)))


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    subparsers = result.add_subparsers(dest="command", required=True)
    status = subparsers.add_parser("status")
    status.add_argument("--repo", required=True)
    status.add_argument("--pr", type=int, action="append", required=True)
    status.add_argument("--head", action="append", required=True, metavar="PR=SHA")
    status.add_argument("--scan-repo", action="append", default=[])
    status.add_argument("--json", action="store_true")
    run = subparsers.add_parser("run")
    run.add_argument("--repo", required=True)
    run.add_argument("--pr", type=int, required=True)
    run.add_argument("--head", required=True)
    run.add_argument("--scan-repo", action="append", default=[])
    run.add_argument("--deadline", required=True)
    run.add_argument("--interval", type=float, default=60.0)
    run.add_argument("--json", action="store_true")
    return result


def parse_heads(values: list[str], prs: list[int]) -> dict[int, str]:
    heads: dict[int, str] = {}
    for value in values:
        number, separator, head = value.partition("=")
        if not separator or not number.isdigit() or not head:
            raise WaitError("--head must use PR=SHA")
        pr = positive_pr(int(number))
        if pr in heads:
            raise WaitError(f"duplicate --head for PR #{pr}")
        heads[pr] = head
    if set(heads) != set(prs):
        raise WaitError("--head entries must match every --pr exactly")
    return heads


def authenticated_login(gh: Gh) -> str:
    login = str((gh.rest("user") or {}).get("login") or "")
    if not login:
        raise WaitError("authenticated GitHub login is unavailable")
    return login


def envelope(
    command: str,
    state: str,
    identity: dict[str, Any],
    value: dict[str, Any],
    metrics: Metrics,
    reason: str,
) -> dict[str, Any]:
    """The command's result, refused unless STATE_COMMANDS declares `state` for `command`."""
    if command not in STATE_COMMANDS.get(state, frozenset()):
        raise WaitError(f"CodeRabbit {command} produced an undeclared state {state!r}")
    kind = f"coderabbit-{command}" if state == "operational-error" else "coderabbit"
    return result_envelope(kind, state, identity, value, metrics, reason)


def main() -> int:
    args = parser().parse_args()
    metrics = Metrics(time.monotonic())
    identity: dict[str, Any] = {"repo": args.repo, "prs": getattr(args, "pr", None)}
    try:
        gh = Gh(metrics)
        scan_repos = list(dict.fromkeys([args.repo, *args.scan_repo]))
        for repo in scan_repos:
            repo_parts(repo)
        if args.command == "status":
            prs = [positive_pr(value) for value in args.pr]
            if len(set(prs)) != len(prs):
                raise WaitError("--pr values must be unique")
            heads = parse_heads(args.head, prs)
            identity["heads"] = heads
            lock = lock_status(authenticated_login(gh))
            value = observation(gh, args.repo, prs, heads, scan_repos, time.time()) | {"lock": lock}
            metrics.observations += 1
            state, reason = aggregate_status(value)
            output = envelope("status", state, identity, value, metrics, reason)
        else:
            args.pr = positive_pr(args.pr)
            args.interval = positive_interval(args.interval)
            deadline = parse_time(args.deadline)
            identity = {"repo": args.repo, "prs": [args.pr], "heads": {args.pr: args.head}}
            login = authenticated_login(gh)
            holder = {"repo": args.repo, "pr": args.pr, "head": args.head}
            lock = acquire_lock(login, holder, deadline, args.interval)
            if lock is None:
                output = envelope(
                    "run", "lock-held", identity, {"lock": lock_status(login)}, metrics,
                    "another CodeRabbit run held the account lock until the deadline",
                )
            else:
                try:
                    state, reason, value = run_review(
                        gh, args.repo, args.pr, args.head, scan_repos, deadline, args.interval,
                    )
                    metrics.observations += 1
                    output = envelope("run", state, identity, value, metrics, reason)
                finally:
                    release_lock(lock)
        emit(output, args.json)
        return 0
    except WaitError as error:
        output = envelope(args.command, "operational-error", identity, {}, metrics, str(error))
        emit(output, getattr(args, "json", False))
        return 2


if __name__ == "__main__":
    sys.exit(main())
