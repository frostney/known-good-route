#!/usr/bin/env python3
"""Deterministic CodeRabbit review pacing and completion adapter."""

from __future__ import annotations

import argparse
import fcntl
import re
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, TextIO
from urllib.parse import quote

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
STATED_WAIT = re.compile(
    r"(?:available in\D{0,10}|please wait\W{0,10})"
    r"(\d+)\s*minutes?(?:\D{0,10}(\d+)\s*seconds?)?",
    re.IGNORECASE,
)
FINISHED = re.compile(r"review finished|reviews? (?:is|are) complete|no actionable comments", re.IGNORECASE)
SKIPPED = re.compile(r"review skipped", re.IGNORECASE)
RATE_LIMITED = re.compile(r"rate limited|review limit", re.IGNORECASE)
ALREADY_REVIEWED = re.compile(
    r"action not completed[\s\S]{0,300}?already reviewed", re.IGNORECASE
)
ACTIONABLE = re.compile(r"Actionable comments posted:\s*(\d+)", re.IGNORECASE)
UNAVAILABLE_SOURCE = re.compile(r"\(HTTP 40[34]\)")
WAIT_BUFFER_SECONDS = 60
TRUSTED_ACK_SECONDS = 30
# CodeRabbit states the account's included review allowance in each review's
# summary, e.g. "1 included review remains after this review. ... set your
# current allowance at 2 reviews per hour." Older summaries say "N reviews are
# currently available", "included reviews refill at N per hour", or "You've
# used all N included reviews currently available"; tests/fixtures holds each
# wording CodeRabbit has published.
ALLOWANCE_RATE = re.compile(
    r"(?:allowance at|refill at) (\d+)(?: reviews?)? per (minute|hour|day)\b",
    re.IGNORECASE,
)
ALLOWANCE_USED_ALL = re.compile(
    r"used (?:all \d+ included reviews?|the included review) currently available",
    re.IGNORECASE,
)
ALLOWANCE_REMAINING = (
    re.compile(r"(\d+) included reviews? remains? after this review", re.IGNORECASE),
    re.compile(r"(\d+) reviews? (?:is|are) currently available", re.IGNORECASE),
)
RUN_ID = re.compile(r"Run ID\W{0,6}`([0-9A-Za-z-]+)`", re.IGNORECASE)
# A rate-limit notice prints the refused run's ID beside its limit details.
RATE_LIMIT_NOTICE = re.compile(r"rate limited by coderabbit", re.IGNORECASE)
WINDOW_SECONDS = {"minute": 60, "hour": 3600, "day": 86400}
# A statement without a rate is read against the hour, the unit of every rated
# statement CodeRabbit has published; the budget then reports `degraded`.
UNRATED_WINDOW_SECONDS = WINDOW_SECONDS["hour"]
# The scan covers two windows: the window of a statement made up to one window
# ago reaches back that far again.
ALLOWANCE_LOOKBACK_WINDOWS = 2
# Stated waits last until a slot in CodeRabbit's hourly window frees; the
# longest in frostney/GocciaScript's history is 59 minutes. A wait edited
# before this horizon would have to state over 1 hour 59 minutes to be active.
WAIT_LOOKBACK_SECONDS = 2 * 3600



def is_coderabbit_check_name(value: str) -> bool:
    return "coderabbit" in value.lower()


def check_text_rate_limited(*parts: Any) -> bool:
    """True when any supplied check/status text matches RATE_LIMITED."""
    for part in parts:
        text = str(part or "")
        if text and RATE_LIMITED.search(text):
            return True
    return False


def coderabbit_check_output_texts(run: dict[str, Any]) -> tuple[str, str, str]:
    output = run.get("output") if isinstance(run.get("output"), dict) else {}
    return (
        str(output.get("title") or ""),
        str(output.get("summary") or ""),
        str(output.get("text") or ""),
    )


def page_entries(pages: list[Any], key: str) -> list[dict[str, Any]]:
    """Flatten the named array of each object-shaped page, skipping malformed items."""
    return [
        entry
        for page in pages
        if isinstance(page, dict)
        for entry in page.get(key, [])
        if isinstance(entry, dict)
    ]


def optional_items(fetch: Callable[[], list[Any]]) -> list[Any]:
    """Items from a source the repository may not expose.

    A missing or forbidden endpoint yields no items; every other failure,
    including rate limits and transport errors, propagates.
    """
    try:
        return fetch()
    except (RateLimited, TransientError):
        raise
    except WaitError as error:
        if UNAVAILABLE_SOURCE.search(str(error)):
            return []
        raise


def coderabbit_check_for_head(gh: Gh, repo: str, head: str) -> dict[str, Any]:
    """Resolve head-scoped CodeRabbit check-run or commit-status SUCCESS.

    A completed SUCCESS conclusion whose output title/summary/text (or commit-
    status description) matches RATE_LIMITED is not treated as SUCCESS — it
    surfaces rateLimited so callers do not count a rate-limited pass as
    codeRabbitCheckSuccess.
    """
    run_pages = gh.rest_pages(f"repos/{repo}/commits/{head}/check-runs?per_page=100")
    for run in page_entries(run_pages, "check_runs"):
        name = str(run.get("name") or "")
        if not is_coderabbit_check_name(name):
            continue
        run_head = run.get("head_sha")
        if isinstance(run_head, str) and run_head and run_head != head:
            continue
        if (
            str(run.get("status") or "").upper() == "COMPLETED"
            and str(run.get("conclusion") or "").upper() == "SUCCESS"
        ):
            title, summary, text = coderabbit_check_output_texts(run)
            if check_text_rate_limited(title, summary, text):
                return {
                    "state": "RATE_LIMITED",
                    "source": "check-run",
                    "name": name,
                    "head": head,
                    "rateLimited": True,
                }
            return {
                "state": "SUCCESS",
                "source": "check-run",
                "name": name,
                "head": head,
            }

    statuses = rest_items(gh, f"repos/{repo}/commits/{head}/statuses?per_page=100")
    seen_contexts: set[str] = set()
    for status in statuses:
        context = str(status.get("context") or "")
        if not is_coderabbit_check_name(context) or context in seen_contexts:
            continue
        seen_contexts.add(context)
        state = str(status.get("state") or "").upper()
        description = str(status.get("description") or "")
        if state == "SUCCESS" and check_text_rate_limited(description):
            return {
                "state": "RATE_LIMITED",
                "source": "status",
                "name": context,
                "head": head,
                "rateLimited": True,
            }
        return {
            "state": state or None,
            "source": "status",
            "name": context,
            "head": head,
        }

    return {"state": None, "source": None, "name": None, "head": head}

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


def is_bot(item: dict[str, Any]) -> bool:
    return str((item.get("user") or {}).get("login") or "").lower() in BOT_LOGINS


def rest_items(gh: Gh, endpoint: str) -> list[dict[str, Any]]:
    pages = gh.rest_pages(endpoint)
    items: list[dict[str, Any]] = []
    for page in pages:
        if not isinstance(page, list) or not all(isinstance(item, dict) for item in page):
            raise WaitError(f"paginated GitHub response for {endpoint} is invalid")
        items.extend(page)
    return items


def latest(items: list[dict[str, Any]], field: str) -> dict[str, Any] | None:
    candidates = [item for item in items if isinstance(item.get(field), str)]
    return max(candidates, key=lambda item: str(item[field]), default=None)


def account_wait(gh: Gh, repos: list[str], now: float) -> dict[str, Any] | None:
    """The newest stated wait in comments edited within WAIT_LOOKBACK_SECONDS."""
    candidates: list[dict[str, Any]] = []
    for repo in repos:
        repo_parts(repo)
        comments = rest_items(
            gh, allowance_comments_endpoint(repo, now - WAIT_LOOKBACK_SECONDS)
        )
        for comment in comments:
            if not is_bot(comment):
                continue
            match = STATED_WAIT.search(str(comment.get("body") or ""))
            if not match:
                continue
            updated_at = parse_timestamp(comment.get("updated_at"), "wait updated_at")
            seconds = int(match.group(1)) * 60 + int(match.group(2) or 0)
            issue_url = str(comment.get("issue_url") or "")
            candidates.append(
                {
                    "repo": repo,
                    "pr": int(issue_url.rsplit("/", 1)[-1]) if issue_url.rsplit("/", 1)[-1].isdigit() else None,
                    "updatedAt": comment["updated_at"],
                    "updatedAtEpoch": updated_at,
                    "statedSeconds": seconds,
                    "retryAt": format_timestamp(updated_at + seconds + WAIT_BUFFER_SECONDS),
                    "retryAtEpoch": updated_at + seconds + WAIT_BUFFER_SECONDS,
                }
            )
    return max(candidates, key=lambda item: item["updatedAt"], default=None)


def parse_allowance(text: str) -> dict[str, Any] | None:
    """CodeRabbit's stated review allowance, or None when the text states none.

    `allowance` and `unit` are None when the statement gives no rate;
    `remaining` is None when it gives no count.
    """
    rate = ALLOWANCE_RATE.search(text)
    if rate and int(rate.group(1)) < 1:
        rate = None
    remaining: int | None = None
    offsets = [rate.start()] if rate else []
    used_all = ALLOWANCE_USED_ALL.search(text)
    if used_all:
        remaining = 0
        offsets.append(used_all.start())
    else:
        for pattern in ALLOWANCE_REMAINING:
            match = pattern.search(text)
            if match:
                remaining = int(match.group(1))
                offsets.append(match.start())
                break
    if not offsets:
        return None
    unit = rate.group(2).lower() if rate else None
    return {
        "offset": min(offsets),
        "remaining": remaining,
        "allowance": int(rate.group(1)) if rate else None,
        "unit": unit,
        "windowSeconds": WINDOW_SECONDS[unit] if unit else UNRATED_WINDOW_SECONDS,
    }


def issue_number(item: dict[str, Any]) -> int | None:
    tail = str(item.get("issue_url") or "").rsplit("/", 1)[-1]
    return int(tail) if tail.isdigit() else None


def allowance_comments_endpoint(repo: str, since: float) -> str:
    return (
        f"repos/{repo}/issues/comments?sort=updated&direction=desc"
        f"&per_page=100&since={format_timestamp(int(since))}"
    )


def scan_allowance(
    gh: Gh, repos: list[str], since: float
) -> tuple[dict[str, Any] | None, dict[tuple[str, str], float]]:
    """The newest allowance statement and every identified review run since `since`.

    A run is one CodeRabbit review, identified by the Run ID it prints in its
    summary statement and in any review object it submits. Each run counts
    once, at its earliest observed time. Evidence without a Run ID is not
    counted, so the count is a lower bound of the account's runs. A summary's
    "Currently processing" marker is not counted: CodeRabbit also shows it
    while a review waits for allowance and then ends without using one.
    """
    statements: list[dict[str, Any]] = []
    runs: dict[tuple[str, str], float] = {}

    def note_run(repo: str, run_id: str, at: float) -> None:
        runs[(repo, run_id)] = min(runs.get((repo, run_id), at), at)

    for repo in repos:
        repo_parts(repo)
        prs: set[int] = set()
        for item in rest_items(gh, allowance_comments_endpoint(repo, since)):
            if not is_bot(item):
                continue
            updated = parse_timestamp(item.get("updated_at"), "comment updated_at")
            if updated < since:
                continue
            pr = issue_number(item)
            if pr is not None:
                prs.add(pr)
            body = str(item.get("body") or "")
            parsed = parse_allowance(body)
            if parsed is None:
                continue
            statements.append(
                parsed
                | {
                    "repo": repo,
                    "pr": pr,
                    "commentId": item.get("id"),
                    "updatedAt": item["updated_at"],
                    "updatedAtEpoch": updated,
                }
            )
            # The run a statement describes prints its ID just above it; a
            # skip or pause notice earlier in the comment has its own, and a
            # rate-limit notice's run was refused.
            run_ids = RUN_ID.findall(body, 0, parsed["offset"])
            if run_ids and not RATE_LIMIT_NOTICE.search(body):
                note_run(repo, run_ids[-1], updated)
        for pr in sorted(prs):
            reviews = optional_items(
                lambda: rest_items(gh, f"repos/{repo}/pulls/{pr}/reviews?per_page=100")
            )
            for item in reviews:
                body = str(item.get("body") or "")
                run = RUN_ID.search(body)
                if not is_bot(item) or item.get("state") == "PENDING" or not run:
                    continue
                submitted = parse_timestamp(item.get("submitted_at"), "review submitted_at")
                if submitted < since:
                    continue
                note_run(repo, run.group(1), submitted)
                # CodeRabbit may state the allowance in its review body only.
                parsed = parse_allowance(body)
                if parsed is not None:
                    statements.append(
                        parsed
                        | {
                            "repo": repo,
                            "pr": pr,
                            "reviewId": item.get("id"),
                            "updatedAt": item["submitted_at"],
                            "updatedAtEpoch": submitted,
                        }
                    )
    statement = max(statements, key=lambda item: item["updatedAtEpoch"], default=None)
    return statement, runs


def allowance_retry(
    runs: list[float], window: float, allowance: int, at: float, *, proven: bool
) -> float | None:
    """When a review slot frees after `at`, from the runs in the window ending then.

    A slot frees once enough counted runs leave the trailing window. With fewer
    counted runs than the allowance, only a `proven` exhaustion (a statement or
    notice from CodeRabbit) yields a time: its oldest counted run. Uncounted
    runs can only be older, so the derived time is never early.
    """
    counted = sorted(run for run in runs if at - window < run <= at)
    excess = len(counted) - allowance + 1
    if not counted or (excess < 1 and not proven):
        return None
    return counted[min(max(excess, 1), len(counted)) - 1] + window + WAIT_BUFFER_SECONDS


def account_allowance(gh: Gh, repos: list[str], now: float) -> dict[str, Any]:
    """The account's review budget from CodeRabbit's statements and counted runs.

    `mode` is `enforced` when the newest statement is within its window and
    states a rate, and `degraded` otherwise. Without a current statement only
    stated waits gate triggers. A current statement that reports none left
    always holds triggers, whether or not runs could be counted.
    """
    window = WINDOW_SECONDS["hour"]
    statement, runs = scan_allowance(gh, repos, now - ALLOWANCE_LOOKBACK_WINDOWS * window)
    if statement and statement["windowSeconds"] > window:
        window = statement["windowSeconds"]
        statement, runs = scan_allowance(
            gh, repos, now - ALLOWANCE_LOOKBACK_WINDOWS * window
        )
    budget: dict[str, Any] = {
        "mode": "degraded",
        "reason": (
            "no allowance statement within its window in the scanned "
            "repositories; only stated waits gate triggers"
        ),
        "remaining": None,
        "perHour": None,
        "reviewsPerWindow": None,
        "windowSeconds": None,
        "statementAt": None,
        "source": None,
        "attempts": {"count": 0, "windowStart": None, "runs": []},
        "exhausted": False,
        "retryAt": None,
        "exhaustionRetryEpoch": None,
        "runEpochs": [],
    }
    if statement is None or statement["updatedAtEpoch"] <= now - statement["windowSeconds"]:
        return budget
    window = statement["windowSeconds"]
    allowance = statement["allowance"]
    remaining = statement["remaining"]
    stated_at = statement["updatedAtEpoch"]
    run_epochs = sorted(runs.values())
    in_window = sorted(
        (at, repo, run_id)
        for (repo, run_id), at in runs.items()
        if now - window < at <= now
    )
    budget |= {
        "mode": "enforced" if allowance else "degraded",
        "remaining": remaining,
        "perHour": allowance if statement["unit"] == "hour" else None,
        "reviewsPerWindow": allowance,
        "windowSeconds": window,
        "statementAt": statement["updatedAt"],
        "source": {
            "repo": statement["repo"],
            "pr": statement["pr"],
            **(
                {"reviewId": statement["reviewId"]}
                if "reviewId" in statement
                else {"commentId": statement["commentId"]}
            ),
        },
        "attempts": {
            "count": len(in_window),
            "windowStart": format_timestamp(now - window),
            "runs": [
                {"repo": repo, "runId": run_id, "at": format_timestamp(at)}
                for at, repo, run_id in in_window
            ],
        },
        "runEpochs": run_epochs,
    }
    # The newest statement anchors the count: with R reviews left when it was
    # made, the allowance is used up from the R-th identified run after it.
    # Counted times can trail a run's start, so a larger window count alone
    # never overrides the statement.
    after = [at for at in run_epochs if at > stated_at]
    exhausted_at: float | None = None
    if remaining == 0:
        exhausted_at = stated_at
    elif remaining is not None and allowance and len(after) >= remaining:
        exhausted_at = after[remaining - 1]
    retry: float | None = None
    if exhausted_at is not None:
        # The run the statement reports on finished by its time, so a slot
        # frees within one window even when no run could be counted.
        derived = (
            allowance_retry(run_epochs, window, allowance, exhausted_at, proven=True)
            if allowance
            else None
        )
        retry = derived if derived is not None else exhausted_at + window + WAIT_BUFFER_SECONDS
    elif remaining is None and allowance:
        retry = allowance_retry(run_epochs, window, allowance, now, proven=False)
    exhausted = retry is not None and retry > now
    if allowance:
        reason = (
            f"{len(in_window)} identified review runs in the trailing window; "
            f"the newest statement leaves {remaining} of {allowance}"
        )
    else:
        reason = (
            "the newest allowance statement states no rate; it is read against "
            "one hour and runs are not counted against it"
        )
    if exhausted:
        reason = f"the included review allowance is used up until retryAt; {reason}"
    budget |= {
        "exhausted": exhausted,
        "retryAt": format_timestamp(retry) if exhausted and retry else None,
        "exhaustionRetryEpoch": retry,
        "reason": reason,
    }
    return budget


def trigger_gate(
    evidence: dict[str, Any], wait: dict[str, Any] | None, budget: dict[str, Any] | None
) -> dict[str, Any] | None:
    """The latest evidenced time before which CodeRabbit would refuse a trigger.

    A stated wait counts unless it predates the PR's rate-limit notice. The
    allowance adds the time its exhaustion ends and, for a notice, when the
    runs counted before it free a slot; an allowance time that precedes the
    notice cannot explain it. Returns None when nothing gates a trigger. For a
    notice that nothing explains, `retryAtEpoch` is None.
    """
    limited = bool(evidence.get("rateLimited"))
    limited_at = evidence.get("rateLimitedAtEpoch") if limited else None
    unexplained = {"retryAtEpoch": None, "retryAt": None, "source": None}
    if limited and limited_at is None:
        return unexplained
    gates: list[tuple[float, str]] = []
    if wait is not None and (limited_at is None or wait["updatedAtEpoch"] >= limited_at):
        gates.append((wait["retryAtEpoch"], "stated-wait"))
    allowance_times: list[float] = []
    if budget and budget.get("exhaustionRetryEpoch") is not None:
        allowance_times.append(budget["exhaustionRetryEpoch"])
    if budget and budget.get("reviewsPerWindow") and limited_at is not None:
        derived = allowance_retry(
            budget["runEpochs"],
            budget["windowSeconds"],
            budget["reviewsPerWindow"],
            limited_at,
            proven=True,
        )
        if derived is not None:
            allowance_times.append(derived)
    gates.extend(
        (at, "allowance")
        for at in allowance_times
        if limited_at is None or at > limited_at
    )
    if not gates:
        return unexplained if limited else None
    retry, source = max(gates)
    return {"retryAtEpoch": retry, "retryAt": format_timestamp(retry), "source": source}


GATE_REASONS = {
    "stated-wait": "account-scoped stated wait gates the next trigger",
    "allowance": "the account's included CodeRabbit review allowance is used up",
}


def head_push_time(
    gh: Gh, repo: str, pull: dict[str, Any], head: str
) -> tuple[str | None, str | None]:
    """Return when GitHub received the head and which evidence recorded it.

    The committer date is set locally and can precede the push by any amount,
    so it cannot bound evidence about this head. Prefer the branch activity
    entry that moved the head ref to this commit, then the earliest check suite
    GitHub created for the commit on the head branch. Suites are per commit, so
    one created for another branch may predate this push and is ignored. A
    missing or forbidden endpoint only removes that source.
    """
    head_info = pull.get("head") or {}
    head_ref = head_info.get("ref")
    head_repo = (head_info.get("repo") or {}).get("full_name") or repo
    if not isinstance(head_ref, str) or not head_ref:
        return None, None
    ref = quote(f"refs/heads/{head_ref}", safe="/")
    entries = optional_items(
        lambda: rest_items(gh, f"repos/{head_repo}/activity?ref={ref}&per_page=100")
    )
    arrival = latest(
        [entry for entry in entries if entry.get("after") == head], "timestamp"
    )
    if arrival:
        return arrival["timestamp"], "activity"
    pages = optional_items(
        lambda: gh.rest_pages(f"repos/{repo}/commits/{head}/check-suites?per_page=100")
    )
    created = [
        suite["created_at"]
        for suite in page_entries(pages, "check_suites")
        if suite.get("head_branch") == head_ref
        and isinstance(suite.get("created_at"), str)
    ]
    if created:
        return min(created, key=lambda value: parse_timestamp(value, "check suite created_at")), "check-suite"
    return None, None


def pull_evidence(gh: Gh, repo: str, pr: int) -> dict[str, Any]:
    repo_parts(repo)
    pr = positive_pr(pr)
    pull = gh.rest(f"repos/{repo}/pulls/{pr}")
    if not isinstance(pull, dict):
        raise WaitError(f"pull request {repo}#{pr} response is invalid")
    head = (pull.get("head") or {}).get("sha")
    if not isinstance(head, str) or not head:
        raise WaitError(f"pull request {repo}#{pr} is missing its head SHA")
    commit = gh.rest(f"repos/{repo}/commits/{head}")
    committed_at = (
        ((commit or {}).get("commit") or {}).get("committer") or {}
    ).get("date")
    committed_epoch = parse_timestamp(committed_at, "head commit time")
    pushed_at, push_source = head_push_time(gh, repo, pull, head)
    pushed_epoch = (
        max(committed_epoch, parse_timestamp(pushed_at, "head push time"))
        if pushed_at
        else committed_epoch
    )

    comments = rest_items(gh, f"repos/{repo}/issues/{pr}/comments?per_page=100")
    reviews = rest_items(gh, f"repos/{repo}/pulls/{pr}/reviews?per_page=100")
    files = rest_items(gh, f"repos/{repo}/pulls/{pr}/files?per_page=100")
    bot_comments = [item for item in comments if is_bot(item)]
    trigger_comments = [
        item
        for item in comments
        if not is_bot(item)
        and str(item.get("body") or "").strip().lower() in set(TRIGGERS.values())
        and parse_timestamp(item.get("created_at"), "trigger created_at") >= pushed_epoch
    ]
    trigger = latest(trigger_comments, "created_at")
    boundary = max(
        pushed_epoch,
        parse_timestamp(trigger.get("created_at"), "trigger created_at") if trigger else pushed_epoch,
    )

    exact_reviews = []
    for review in reviews:
        match = ACTIONABLE.search(str(review.get("body") or ""))
        if (
            is_bot(review)
            and review.get("state") != "PENDING"
            and review.get("commit_id") == head
            and match
        ):
            exact_reviews.append(
                {
                    "id": review.get("id"),
                    "submittedAt": review.get("submitted_at"),
                    "actionable": int(match.group(1)),
                }
            )
    exact_review = latest(exact_reviews, "submittedAt")

    after_boundary = [
        item
        for item in bot_comments
        if parse_timestamp(item.get("created_at"), "comment created_at") >= boundary
    ]
    finished = latest(
        [
            item
            for item in after_boundary
            if FINISHED.search(str(item.get("body") or ""))
            and not SKIPPED.search(str(item.get("body") or ""))
        ],
        "created_at",
    )
    skipped = latest(
        [item for item in after_boundary if SKIPPED.search(str(item.get("body") or ""))],
        "created_at",
    )
    limited = latest(
        [item for item in after_boundary if RATE_LIMITED.search(str(item.get("body") or ""))],
        "created_at",
    )
    refused = latest(
        [item for item in after_boundary if ALREADY_REVIEWED.search(str(item.get("body") or ""))],
        "created_at",
    )
    walkthrough = latest(
        [
            item
            for item in bot_comments
            if "summarize by coderabbit" in str(item.get("body") or "").lower()
            and parse_timestamp(item.get("updated_at"), "walkthrough updated_at") >= pushed_epoch
        ],
        "updated_at",
    )
    filenames = [str(item.get("filename") or "") for item in files]
    walkthrough_body = str((walkthrough or {}).get("body") or "")
    matched = sum(
        1
        for filename in filenames
        if filename and (filename in walkthrough_body or Path(filename).name in walkthrough_body)
    )
    ack_latency = (
        parse_timestamp(finished.get("created_at"), "finished created_at") - boundary
        if finished
        else None
    )
    trigger_mode = None
    if trigger:
        trigger_mode = next(
            mode
            for mode, body in TRIGGERS.items()
            if body == str(trigger.get("body") or "").strip().lower()
        )

    code_rabbit_check = coderabbit_check_for_head(gh, repo, head)
    check_rate_limited = bool(code_rabbit_check.get("rateLimited"))

    return {
        "repo": repo,
        "pr": pr,
        "head": head,
        "headCommittedAt": committed_at,
        "headPushedAt": pushed_at,
        "headPushSource": push_source,
        "trigger": (
            {
                "id": trigger.get("id"),
                "mode": trigger_mode,
                "createdAt": trigger.get("created_at"),
            }
            if trigger
            else None
        ),
        "exactHeadReview": exact_review,
        "finishedAck": (
            {
                "id": finished.get("id"),
                "createdAt": finished.get("created_at"),
                "latencySeconds": int(max(0, ack_latency or 0)),
            }
            if finished
            else None
        ),
        "skippedAck": bool(skipped),
        "rateLimited": bool(limited) or check_rate_limited,
        "rateLimitedAt": limited.get("created_at") if limited else None,
        "rateLimitedAtEpoch": (
            parse_timestamp(limited.get("created_at"), "rate-limit created_at")
            if limited
            else None
        ),
        "alreadyReviewed": bool(refused),
        "coverage": {
            "walkthroughId": (walkthrough or {}).get("id"),
            "matched": matched,
            "changed": len(filenames),
            "verified": matched > 0,
        },
        "codeRabbitCheck": code_rabbit_check,
        "codeRabbitCheckSuccess": code_rabbit_check.get("state") == "SUCCESS",
    }


def classify(
    evidence: dict[str, Any],
    expected_head: str,
    wait: dict[str, Any] | None,
    now: float,
    budget: dict[str, Any] | None = None,
) -> tuple[str, str, str | None]:
    if evidence["head"] != expected_head:
        return "invalidated", f"expected head {expected_head}, observed {evidence['head']}", None
    if evidence["exactHeadReview"]:
        return "review-complete", "exact-head actionable review object observed", None
    ack = evidence["finishedAck"]

    # Rate-limit evidence must win over a SUCCESS check short-circuit: a green
    # CodeRabbit check whose description is "Review rate limited" is pending,
    # not clean-complete.
    if evidence["rateLimited"]:
        gate = trigger_gate(evidence, wait, budget)
        if gate is None or gate["retryAtEpoch"] is None:
            return (
                "pending-retry-source",
                "rate limited without a stated retry time or an allowance-derived one",
                None,
            )
        desired = evidence["trigger"]["mode"] if evidence["trigger"] else "incremental"
        if gate["retryAtEpoch"] > now:
            return "waiting", GATE_REASONS[gate["source"]], desired
        return f"trigger-{desired}", f"{desired} review trigger is permitted", desired

    code_rabbit_ok = bool(evidence.get("codeRabbitCheckSuccess")) or (
        (evidence.get("codeRabbitCheck") or {}).get("state") == "SUCCESS"
    )
    # Without a GitHub-recorded push time, an acknowledgment may belong to the
    # previous head, so only the head-scoped check can complete the review.
    push_known = evidence.get("headPushedAt") is not None
    trusted_latency = bool(ack) and ack["latencySeconds"] >= TRUSTED_ACK_SECONDS
    latency_ok = push_known and trusted_latency
    if ack and evidence["coverage"]["verified"] and (latency_ok or code_rabbit_ok):
        if code_rabbit_ok and not latency_ok:
            reason = (
                "finished acknowledgment has current walkthrough coverage "
                "and head-scoped CodeRabbit check SUCCESS"
            )
        else:
            reason = "finished acknowledgment has current walkthrough coverage"
        return "clean-complete", reason, None
    if evidence["skippedAck"]:
        return "pending-skipped", "CodeRabbit reported that review was skipped", None
    if trusted_latency and not push_known and evidence["coverage"]["verified"]:
        return (
            "pending-check-required",
            "head push time is unknown, so clean completion requires the "
            "head-scoped CodeRabbit check",
            None,
        )

    desired: str | None = None
    trigger_mode = (evidence.get("trigger") or {}).get("mode")
    if evidence["alreadyReviewed"] and trigger_mode == "full":
        return "pending-full-refused", "CodeRabbit refused an explicit full review", None
    if ack and trigger_mode == "full":
        return "pending-full-unverified", "full-review acknowledgment did not prove current diff coverage", None
    if evidence["alreadyReviewed"] or ack:
        desired = "full"
    elif evidence["trigger"]:
        return "in-flight", "trigger is awaiting completion evidence", None
    else:
        desired = "incremental"

    gate = trigger_gate(evidence, wait, budget)
    if gate is not None and gate["retryAtEpoch"] is not None and gate["retryAtEpoch"] > now:
        return "waiting", GATE_REASONS[gate["source"]], desired
    return f"trigger-{desired}", f"{desired} review trigger is permitted", desired


def observation(
    gh: Gh,
    repo: str,
    prs: list[int],
    expected_heads: dict[int, str],
    scan_repos: list[str],
    now: float,
) -> dict[str, Any]:
    wait = account_wait(gh, scan_repos, now)
    budget = account_allowance(gh, scan_repos, now)
    results = []
    for pr in prs:
        evidence = pull_evidence(gh, repo, pr)
        state, reason, next_mode = classify(
            evidence, expected_heads[pr], wait, now, budget
        )
        gate = trigger_gate(evidence, wait, budget) if state == "waiting" else None
        results.append(
            evidence
            | {
                "state": state,
                "reason": reason,
                "nextMode": next_mode,
                "retryAt": gate["retryAt"] if gate else None,
                "retrySource": gate["source"] if gate else None,
            }
        )
    return {
        "scanRepos": scan_repos,
        "accountWait": (
            {
                key: value
                for key, value in wait.items()
                if key not in {"retryAtEpoch", "updatedAtEpoch"}
            }
            if wait
            else None
        ),
        "allowance": {
            key: value
            for key, value in budget.items()
            if key not in {"exhaustionRetryEpoch", "runEpochs"}
        },
        "pullRequests": results,
    }


def aggregate_status(value: dict[str, Any]) -> tuple[str, str]:
    states = [item["state"] for item in value["pullRequests"]]
    if any(state == "invalidated" for state in states):
        return "invalidated", "at least one requested PR head changed"
    if all(state in {"review-complete", "clean-complete"} for state in states):
        return "satisfied", "every requested exact head has trustworthy completion evidence"
    return "pending", "at least one requested exact head still needs a review transition"


def acquire_lock(login: str, deadline: float, interval: float) -> TextIO | None:
    directory = Path(tempfile.gettempdir()) / "known-good-route-coderabbit"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"account-{stable_digest(login)[:16]}.lock"
    handle = path.open("a+")
    while True:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            handle.seek(0)
            handle.truncate()
            handle.write(f"{login} {time.time()}\n")
            handle.flush()
            return handle
        except BlockingIOError:
            if time.time() >= deadline:
                handle.close()
                return None
            time.sleep(min(interval, max(0.0, deadline - time.time())))


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
    triggers: list[dict[str, Any]] = []
    last: dict[str, Any] = {}
    while True:
        try:
            last = observation(gh, repo, [pr], {pr: head}, scan_repos, clock())
        except (RateLimited, TransientError):
            gh.metrics.retries += 1
            if clock() >= deadline:
                return "pending", "GitHub transport remained unavailable until the deadline", last
            sleeper(min(interval, max(0.0, deadline - clock())))
            continue
        item = last["pullRequests"][0]
        state = item["state"]
        if state in {"review-complete", "clean-complete"}:
            last["triggers"] = triggers
            return "satisfied", item["reason"], last
        if state == "invalidated":
            last["triggers"] = triggers
            return "invalidated", item["reason"], last
        if state in {
            "pending-skipped",
            "pending-full-refused",
            "pending-full-unverified",
            "pending-check-required",
        }:
            last["triggers"] = triggers
            return "pending", item["reason"], last
        if state.startswith("trigger-"):
            if clock() >= deadline:
                last["triggers"] = triggers
                return "pending", "deadline reached before the permitted trigger", last
            mode = item["nextMode"]
            body = TRIGGERS[mode]
            created = gh.rest(
                f"repos/{repo}/issues/{pr}/comments", "POST", {"body": body}
            )
            triggers.append(
                {
                    "mode": mode,
                    "body": body,
                    "commentId": (created or {}).get("id"),
                }
            )
        if clock() >= deadline:
            last["triggers"] = triggers
            return "pending", "deadline reached before trustworthy review completion", last
        sleeper(min(interval, max(0.0, deadline - clock())))


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


def main() -> int:
    args = parser().parse_args()
    metrics = Metrics(time.monotonic())
    identity: dict[str, Any] = {"repo": args.repo, "prs": getattr(args, "pr", None)}
    try:
        gh = Gh(metrics)
        scan_repos = list(dict.fromkeys([args.repo, *args.scan_repo]))
        if args.command == "status":
            prs = [positive_pr(value) for value in args.pr]
            if len(set(prs)) != len(prs):
                raise WaitError("--pr values must be unique")
            heads = parse_heads(args.head, prs)
            identity["heads"] = heads
            output_observation = observation(
                gh, args.repo, prs, heads, scan_repos, time.time()
            )
            metrics.observations += 1
            state, reason = aggregate_status(output_observation)
            output = result_envelope(
                "coderabbit", state, identity, output_observation, metrics, reason,
            )
        else:
            args.pr = positive_pr(args.pr)
            args.interval = positive_interval(args.interval)
            deadline = parse_time(args.deadline)
            identity = {"repo": args.repo, "prs": [args.pr], "heads": {args.pr: args.head}}
            account = gh.rest("user")
            login = str((account or {}).get("login") or "")
            if not login:
                raise WaitError("authenticated GitHub login is unavailable")
            lock = acquire_lock(login, deadline, args.interval)
            if lock is None:
                output = result_envelope(
                    "coderabbit", "pending", identity, {}, metrics,
                    "another CodeRabbit run held the account lock until the deadline",
                )
            else:
                try:
                    state, reason, output_observation = run_review(
                        gh, args.repo, args.pr, args.head, scan_repos,
                        deadline, args.interval,
                    )
                    metrics.observations += 1
                    output = result_envelope(
                        "coderabbit", state, identity, output_observation, metrics, reason
                    )
                finally:
                    fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
                    lock.close()
        emit(output, args.json)
        return 0
    except WaitError as error:
        output = result_envelope(
            f"coderabbit-{args.command}", "operational-error", identity, {}, metrics, str(error)
        )
        emit(output, getattr(args, "json", False))
        return 2


if __name__ == "__main__":
    sys.exit(main())
