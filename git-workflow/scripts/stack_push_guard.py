#!/usr/bin/env python3
"""Bind native stack pushes to approved Git objects. Standard library only."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
from datetime import datetime, timezone
import urllib.parse
import uuid

sys.dont_write_bytecode = True  # Keep installed skill trees free of __pycache__.


class GuardError(RuntimeError):
    pass


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def digest(value):
    return hashlib.sha256(encode(value)).hexdigest()


def pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise GuardError("duplicate JSON key")
        result[key] = value
    return result


def load_json(raw):
    return json.loads(raw, object_pairs_hook=pairs)


def write_once(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(encode(value))
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def read_record(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise GuardError("admission is not a regular owned file")
    value = load_json(path.read_bytes())
    if (not isinstance(value, dict) or set(value) != {"schemaVersion", "request", "digest"}
            or type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1
            or value["digest"] != digest(value["request"])):
        raise GuardError("admission record is corrupt")
    return value["request"]


def validate_admission(value):
    if not isinstance(value, dict) or set(value) - {"rewrite"} != {"directory", "remote", "url", "refs"}:
        raise GuardError("invalid admission fields")
    if not isinstance(value["directory"], str) or not Path(value["directory"]).is_absolute():
        raise GuardError("checkout must be an absolute path")
    if not isinstance(value["remote"], str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*", value["remote"]):
        raise GuardError("invalid remote name")
    if not isinstance(value["url"], str) or not value["url"] or any(ord(c) < 32 for c in value["url"]):
        raise GuardError("invalid remote URL")
    if not isinstance(value["refs"], list) or not value["refs"]:
        raise GuardError("admission needs explicit branch refs")
    refs, seen, lengths = [], set(), set()
    for row in value["refs"]:
        if not isinstance(row, dict) or set(row) != {"ref", "source", "expected"}:
            raise GuardError("invalid admitted ref fields")
        ref = row["ref"]
        if (not isinstance(ref, str) or not ref.startswith("refs/heads/") or ref.endswith(("/", "."))
                or any(ord(c) <= 32 or ord(c) == 127 or c in "~^:?*[\\" for c in ref)
                or any(part.startswith(".") or part.endswith(".lock") for part in ref.split("/"))
                or any(part in ref for part in ("..", "@{", "//")) or ref in seen):
            raise GuardError("invalid or duplicate admitted branch ref")
        for name in ("source", "expected"):
            if not isinstance(row[name], str) or not re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", row[name]):
                raise GuardError("invalid Git object ID")
            lengths.add(len(row[name]))
        if set(row["source"]) == {"0"}:
            raise GuardError("branch deletion is outside this publication helper")
        seen.add(ref)
        refs.append({"ref": ref, "source": row["source"], "expected": row["expected"]})
    if len(lengths) != 1:
        raise GuardError("mixed Git object formats")
    result = {"directory": value["directory"], "remote": value["remote"], "url": value["url"], "refs": refs}
    if "rewrite" in value:
        if not isinstance(value["rewrite"], list) or not value["rewrite"]:
            raise GuardError("rewrite needs explicit entries")
        rewrite, listed = [], set()
        for row in value["rewrite"]:
            if not isinstance(row, dict) or set(row) != {"ref", "reason"}:
                raise GuardError("invalid rewrite fields")
            if not isinstance(row["ref"], str) or row["ref"] not in seen or row["ref"] in listed:
                raise GuardError("rewrite names a ref that is not admitted, or names it twice")
            if not isinstance(row["reason"], str) or not row["reason"].strip():
                raise GuardError("rewrite needs a reason for each ref")
            listed.add(row["ref"])
            rewrite.append({"ref": row["ref"], "reason": row["reason"]})
        result["rewrite"] = rewrite
    return result


def validate_updates(admission, remote, url, text):
    c = validate_admission(admission)
    if remote != c["remote"] or url != c["url"]:
        raise GuardError("remote identity changed")
    allowed = {r["ref"]: r for r in c["refs"]}
    seen, updates = set(), []
    for line in text.split("\n"):
        if not line:
            continue
        parts = line.split(" ")
        if len(parts) != 4:
            raise GuardError("invalid update record")
        local, source, ref, expected = parts
        row = allowed.get(ref)
        if row is None or local != ref or ref in seen:
            raise GuardError("unexpected or duplicated ref update")
        if source != row["source"] or expected != row["expected"]:
            raise GuardError("queued source or advertised remote head differs from admission")
        seen.add(ref)
        updates.append({"ref": ref, "source": source, "expected": expected})
    return updates


def admit_updates(admission, remote, url, text, api=None):
    """What the hook admits: only updates the record lists, and none that moves a
    pull request GitHub now protects."""
    updates = validate_updates(admission, remote, url, text)
    return updates, check_rewrites({**validate_admission(admission), "refs": updates}, api or github_api)


def git(directory, *args):
    result = subprocess.run(["git", *args], cwd=directory, stdin=subprocess.DEVNULL, capture_output=True)
    if result.returncode:
        raise GuardError("Git preflight failed: " + args[0])
    return result.stdout.decode("utf-8").strip()


def config_count(environment):
    raw = environment.get("GIT_CONFIG_COUNT", "0")
    if not re.fullmatch(r"0|[1-9][0-9]*", raw) or int(raw) > 1000:
        raise GuardError("invalid inherited Git config count")
    for number in range(int(raw)):
        if any(f"GIT_CONFIG_{key}_{number}" not in environment for key in ("KEY", "VALUE")):
            raise GuardError("incomplete inherited Git configuration")
    return int(raw)


def github_repository(url):
    """The API host and OWNER/REPO that an HTTPS, ssh:// or scp-style remote URL names."""
    match = (re.fullmatch(r"(?:https|ssh)://(?:[^@/]+@)?([A-Za-z0-9.-]+)(?::[0-9]+)?/([A-Za-z0-9_-]+/[A-Za-z0-9._-]+?)(?:\.git)?/?", url)
             or re.fullmatch(r"(?:[^@/:]+@)?([A-Za-z0-9.-]+):([A-Za-z0-9_-]+/[A-Za-z0-9._-]+?)(?:\.git)?/?", url))
    if not match:
        raise GuardError("remote URL names no GitHub repository, so the pull requests whose head would change cannot be checked")
    # GitHub's SSH-over-HTTPS endpoint serves the same repositories as github.com.
    return ("github.com" if match.group(1) == "ssh.github.com" else match.group(1)), match.group(2)


def gh_api(host, path, *fields):
    try:
        return subprocess.run(["gh", "api", "--hostname", host, path, *fields], stdin=subprocess.DEVNULL,
                              capture_output=True, timeout=60)
    except FileNotFoundError:
        raise GuardError("gh is not installed; it checks the pull requests whose head would change") from None
    except (OSError, subprocess.TimeoutExpired) as error:
        raise GuardError(f"GitHub lookup failed: {path}: {error}") from None


def last_line(result):
    lines = result.stderr.decode("utf-8", "replace").strip().splitlines()
    return lines[-1] if lines else f"gh exited {result.returncode}"


def rate_limited(result):
    """Whether GitHub refused a REST call for its budget: the hourly one or a secondary limit."""
    text = result.stderr.decode("utf-8", "replace").lower()
    return "rate limit" in text or "http 429" in text


def github_api(host, path):
    """A REST lookup; once GitHub refuses it for its budget, the same lookup through GraphQL,
    which has a budget of its own, answered in the shape REST would give."""
    result = gh_api(host, path)
    if result.returncode:
        if rate_limited(result):
            return graphql_lookup(host, path, last_line(result))
        raise GuardError(f"GitHub lookup failed: {path}: " + last_line(result))
    try:
        return json.loads(result.stdout)
    except ValueError:
        raise GuardError(f"GitHub lookup returned invalid JSON: {path}") from None


REPOSITORY_QUERY = "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){nameWithOwner}}"
PULLS_QUERY = """query($owner:String!,$name:String!,$branch:String!){repository(owner:$owner,name:$name){
pullRequests(states:OPEN,headRefName:$branch,first:100){totalCount nodes{number isDraft headRefName headRefOid
headRepository{nameWithOwner}}}}}"""
SUITES_QUERY = """query($owner:String!,$name:String!,$oid:GitObjectID!,$after:String){
repository(owner:$owner,name:$name){object(oid:$oid){... on Commit{checkSuites(first:100,after:$after){
pageInfo{hasNextPage endCursor} nodes{status conclusion workflowRun{databaseId event
workflow{databaseId name}}}}}}}}"""
REST_PATH = re.compile(r"repos/([^/?]+)/([^/?]+)(?:/(pulls|actions/runs)\?(.*))?")
# A head's runs read through GraphQL, kept so each REST page of them comes from one reading.
SUITE_RUNS = {}


def graphql(host, path, why, query, **variables):
    """GraphQL's data for QUERY, or a refusal that names both failures."""
    fields = ["-f", "query=" + query]
    for key, value in variables.items():
        if value is not None:
            fields += ["-f", f"{key}={value}"]
    result = gh_api(host, "graphql", *fields)
    try:
        body = json.loads(result.stdout)
    except ValueError:
        body = None
    errors = body.get("errors") if isinstance(body, dict) else None
    if result.returncode or errors or not isinstance(body, dict) or not isinstance(body.get("data"), dict):
        if errors and isinstance(errors, list) and isinstance(errors[0], dict):
            detail = str(errors[0].get("message") or errors[0].get("type"))
        else:
            detail = last_line(result) if result.returncode else "no data"
        raise GuardError(f"GitHub lookup failed: {path}: REST refused it ({why}), and GraphQL did too: {detail}")
    return body["data"]


def graphql_lookup(host, path, why):
    """Answer a REST lookup the guard makes through GraphQL instead."""
    match = REST_PATH.fullmatch(path)
    if not match:
        raise GuardError(f"GitHub lookup failed: {path}: {why}")
    owner, name, kind, query = match.groups()
    owner, name = urllib.parse.unquote(owner), urllib.parse.unquote(name)
    parameters = dict(urllib.parse.parse_qsl(query or ""))
    if kind is None:
        found = graphql(host, path, why, REPOSITORY_QUERY, owner=owner, name=name).get("repository")
        if not isinstance(found, dict) or not isinstance(found.get("nameWithOwner"), str):
            raise GuardError("GitHub lookup returned no repository for " + owner + "/" + name)
        return {"full_name": found["nameWithOwner"]}
    if kind == "pulls":
        # REST's head=OWNER:BRANCH matches only heads in OWNER's repositories.
        head_owner, branch = parameters["head"].split(":", 1)
        found = graphql(host, path, why, PULLS_QUERY, owner=owner, name=name, branch=branch).get("repository")
        pulls = found.get("pullRequests") if isinstance(found, dict) else None
        if not isinstance(pulls, dict) or not isinstance(pulls.get("nodes"), list) or type(pulls.get("totalCount")) is not int:
            raise GuardError("GitHub lookup returned no pull request list for refs/heads/" + branch)
        if pulls["totalCount"] > len(pulls["nodes"]):
            raise GuardError("more than one page of open pull requests for refs/heads/" + branch
                             + "; they cannot all be checked")
        answer = []
        for node in pulls["nodes"]:
            source = (node.get("headRepository") or {}).get("nameWithOwner") if isinstance(node, dict) else None
            if isinstance(source, str) and source.split("/")[0].lower() != head_owner.lower():
                continue
            node = node if isinstance(node, dict) else {}
            answer.append({"number": node.get("number"), "draft": node.get("isDraft"),
                           "head": {"ref": node.get("headRefName"), "sha": node.get("headRefOid"),
                                    "repo": {"full_name": source} if isinstance(source, str) else None}})
        return answer
    sha, size, page = parameters["head_sha"], int(parameters["per_page"]), int(parameters.get("page", "1"))
    key = (host, owner.lower() + "/" + name.lower(), sha)
    if key not in SUITE_RUNS or page == 1:
        SUITE_RUNS[key] = suite_runs(host, path, why, owner, name, sha)
    runs = SUITE_RUNS[key]
    return {"total_count": len(runs), "workflow_runs": runs[(page - 1) * size:page * size]}


def suite_runs(host, path, why, owner, name, sha):
    """The GitHub Actions runs on a commit, from its check suites, in the shape REST lists them.
    Other apps' check suites have no workflow run and can stay queued for good, so they are
    left out, as REST's list of workflow runs leaves them out."""
    runs, after = [], None
    for _ in range(RUN_PAGES):
        found = graphql(host, path, why, SUITES_QUERY, owner=owner, name=name, oid=sha, after=after).get("repository")
        commit = found.get("object") if isinstance(found, dict) else None
        suites = commit.get("checkSuites") if isinstance(commit, dict) else None
        if (not isinstance(suites, dict) or not isinstance(suites.get("nodes"), list)
                or not isinstance(suites.get("pageInfo"), dict)):
            raise GuardError(f"GitHub lookup returned no check suites for commit {sha}")
        for suite in suites["nodes"]:
            run = suite.get("workflowRun") if isinstance(suite, dict) else None
            if run is None:
                continue
            workflow = run.get("workflow") if isinstance(run, dict) else None
            status, conclusion = suite.get("status"), suite.get("conclusion")
            runs.append({"id": run.get("databaseId") if isinstance(run, dict) else None,
                         "name": workflow.get("name") if isinstance(workflow, dict) else None,
                         "event": run.get("event") if isinstance(run, dict) else None,
                         "status": status.lower() if isinstance(status, str) else None,
                         "conclusion": conclusion.lower() if isinstance(conclusion, str) else None,
                         **({"workflow_id": workflow.get("databaseId")} if isinstance(workflow, dict) else {})})
        if not suites["pageInfo"].get("hasNextPage"):
            return runs
        after = suites["pageInfo"].get("endCursor")
        if not isinstance(after, str):
            raise GuardError(f"GitHub lookup returned no next page of check suites for commit {sha}")
    raise GuardError(f"more than {RUN_PAGES} pages of check suites on commit {sha}; they cannot all be checked")


def check_rewrites(c, api=github_api):
    """Refuse to move the head of an open pull request whose layer is frozen,
    unless `rewrite` lists its ref. A layer is frozen once it is ready for
    review, since the guard cannot see when its review ends, or once CI on its
    draft head has passed. A draft whose runs are queued, in progress, failed
    or cancelled is not frozen. Returns what was observed, for the prepared record."""
    listed = {r["ref"] for r in c.get("rewrite", ())}
    moving = [r for r in c["refs"] if set(r["expected"]) != {"0"} and r["expected"] != r["source"]
              and r["ref"] not in listed]
    if not moving:
        return []
    host, named = github_repository(c["url"])
    # A transferred or renamed repository still answers at its old URL, but the
    # head filter needs its current owner, or it matches no pull request.
    found = api(host, f"repos/{named}")
    if not isinstance(found, dict) or not isinstance(found.get("full_name"), str) or "/" not in found["full_name"]:
        raise GuardError("GitHub lookup returned no repository for " + named)
    repository = found["full_name"]
    owner = repository.split("/")[0]
    observed = []
    for row in moving:
        branch = row["ref"].removeprefix("refs/heads/")
        head = urllib.parse.quote(owner + ":" + branch, safe="")
        pulls = api(host, f"repos/{repository}/pulls?state=open&per_page=100&head={head}")
        if not isinstance(pulls, list):
            raise GuardError("GitHub lookup returned no pull request list for " + row["ref"])
        if len(pulls) >= 100:
            raise GuardError("more than one page of open pull requests for " + row["ref"] + "; they cannot all be checked")
        for pull in pulls:
            try:
                number, draft, sha = pull["number"], pull["draft"], pull["head"]["sha"]
                ref, source = pull["head"]["ref"], (pull["head"]["repo"] or {}).get("full_name")
            except (TypeError, KeyError, AttributeError):
                raise GuardError("GitHub lookup returned an incomplete pull request for " + row["ref"]) from None
            if type(number) is not int or type(draft) is not bool:
                raise GuardError("GitHub lookup returned an incomplete pull request for " + row["ref"])
            if ref != branch or not isinstance(source, str) or source.lower() != repository.lower():
                continue
            if sha != row["expected"]:
                raise GuardError(f"pull request #{number} head is {sha}, not the admitted expected commit")
            total, runs, complete = head_runs(api, host, repository, sha, number)
            observed.append({"ref": row["ref"], "pullRequest": number, "draft": draft,
                             **ci_state(total, runs, complete, number)})
    blocked = [o for o in observed if not o["draft"] or o["ciPassed"]]
    if blocked:
        details = ", ".join(f"#{o['pullRequest']} ({o['ref'].removeprefix('refs/heads/')}: "
                            + ("ready for review" if not o["draft"] else "draft, CI passed on its head")
                            + (f", {o['workflowRuns']} workflow runs on its head" if o["workflowRuns"] else "") + ")"
                            for o in blocked)
        restarted = sum(1 for o in blocked if o["workflowRuns"])
        raise GuardError(f"refusing to move the head of {len(blocked)} open pull request(s): {details}. "
                         f"Pushing would restart CI on {restarted} of them. Push a new top layer instead, "
                         "or list each ref under rewrite with its reason")
    return observed


# A run with one of these conclusions counts as passed; any other conclusion,
# such as failure, cancelled or timed_out, leaves the workflow unpassed.
PASSING = frozenset({"success", "neutral", "skipped"})
RUN_PAGES = 10
# The statuses GitHub gives a workflow run; every one but completed is still going.
RUN_STATUSES = frozenset({"completed", "queued", "in_progress", "waiting", "requested", "pending", "action_required"})
# Runs a push to the pull request's head supersedes.
PULL_REQUEST_EVENTS = frozenset({"pull_request", "pull_request_target"})


def head_runs(api, host, repository, sha, number):
    """Every workflow run on a head, read page by page. Refuses a list that
    changes while it is read. Past RUN_PAGES pages it keeps what it read only
    when that already shows a run still going, which settles that CI has not
    passed; the third value says whether the list is complete."""
    runs, ids, total = [], set(), None
    for page in range(1, RUN_PAGES + 1):
        found = api(host, f"repos/{repository}/actions/runs?per_page=100&page={page}&head_sha={sha}")
        if (not isinstance(found, dict) or type(found.get("total_count")) is not int
                or not isinstance(found.get("workflow_runs"), list)):
            raise GuardError(f"GitHub lookup returned no workflow runs for pull request #{number}")
        if total is not None and found["total_count"] != total:
            raise GuardError(f"the workflow runs of pull request #{number} changed while they were read")
        total = found["total_count"]
        for run in found["workflow_runs"]:
            if (not isinstance(run, dict) or type(run.get("id")) is not int or run.get("status") not in RUN_STATUSES
                    or "workflow_id" not in run
                    or (run["status"] == "completed"
                        and (not isinstance(run.get("conclusion"), str) or not run["conclusion"]))):
                raise GuardError(f"GitHub lookup returned an incomplete workflow run for pull request #{number}")
            if run["id"] in ids:
                raise GuardError(f"the workflow runs of pull request #{number} changed while they were read")
            ids.add(run["id"])
        runs.extend(found["workflow_runs"])
        if len(runs) >= total:
            if len(runs) > total:
                raise GuardError(f"the workflow runs of pull request #{number} changed while they were read")
            return total, runs, True
        if not found["workflow_runs"]:
            raise GuardError(f"GitHub lookup listed fewer workflow runs than it counted for pull request #{number}")
    if any(run["status"] != "completed" for run in runs):
        return total, runs, False
    raise GuardError(f"more than {RUN_PAGES} pages of workflow runs for pull request #{number}; they cannot all be checked")


def ci_state(total, runs, complete, number):
    """Whether a head's CI has passed: no run is queued or in progress, and every
    workflow that ran on the head has a passed run there. A cancelled duplicate
    beside a passed run of the same workflow does not unfreeze it. Also names
    the pull request runs still going, which a push to the head supersedes."""
    going = [run for run in runs if run["status"] != "completed"]
    superseded = [f"{run.get('name') or 'workflow ' + str(run['workflow_id'])} run {run['id']} ({run['status']})"
                  for run in going if run.get("event") in PULL_REQUEST_EVENTS]
    if going:
        return {"workflowRuns": total, "ciPassed": False, "runsGoing": superseded, "runsListed": complete}
    passed = {}
    for run in runs:
        workflow = run["workflow_id"]
        passed[workflow] = passed.get(workflow, False) or run["conclusion"] in PASSING
    return {"workflowRuns": total, "ciPassed": bool(passed) and all(passed.values()), "runsGoing": [],
            "runsListed": complete}


def prepare(value, api=github_api):
    c = validate_admission(value)
    directory = Path(c["directory"])
    if str(directory.resolve(strict=True)) != c["directory"]:
        raise GuardError("checkout path changed")
    if git(directory, "status", "--porcelain"):
        raise GuardError("publication checkout is dirty")
    if git(directory, "remote", "get-url", "--push", c["remote"]) != c["url"]:
        raise GuardError("remote push URL differs from admission")
    object_length = 64 if git(directory, "rev-parse", "--show-object-format") == "sha256" else 40
    for row in c["refs"]:
        git(directory, "check-ref-format", row["ref"])
        if len(row["source"]) != object_length:
            raise GuardError("admission object format differs from repository")
        git(directory, "cat-file", "-e", row["source"] + "^{commit}")
    # Refuse before anything is prepared; the hook checks again at the push,
    # since a pull request can become ready or its CI can pass in between.
    pull_requests = check_rewrites(c, api)
    for o in pull_requests:
        if o["workflowRuns"]:
            going = (("; once the push lands, cancel any of these pull request runs on the old head that its "
                      "concurrency group did not: " + ", ".join(o["runsGoing"])
                      + ("" if o["runsListed"] else f", and others past the first {RUN_PAGES} pages"))
                     if o["runsGoing"] else "")
            print(f"Push guard: moving draft #{o['pullRequest']} restarts its CI ({o['workflowRuns']} workflow runs "
                  f"on its current head){going}", file=sys.stderr)
    count = config_count(os.environ)
    git_dir = Path(git(directory, "rev-parse", "--absolute-git-dir"))
    original_hooks = Path(git(directory, "rev-parse", "--path-format=absolute", "--git-path", "hooks"))
    root = git_dir / "kgr-push-guards" / str(uuid.uuid4())
    hooks = root / "hooks"
    hooks.mkdir(parents=True, mode=0o700)
    original_pre_push = None
    if original_hooks.is_dir():
        for entry in original_hooks.iterdir():
            if entry.name == "pre-push":
                if entry.is_file() and os.access(entry, os.X_OK):
                    original_pre_push = str(entry)
            else:
                (hooks / entry.name).symlink_to(entry)
    source = Path(__file__).read_bytes()
    frozen = root / "guard.py"
    with frozen.open("xb") as stream:
        stream.write(source)
        stream.flush()
        os.fsync(stream.fileno())
    request = {"admission": c, "pullRequests": pull_requests, "directory": str(root), "originalHooks": str(original_hooks),
               "originalPrePush": original_pre_push, "helperDigest": hashlib.sha256(source).hexdigest(),
               "pythonBinary": str(Path(sys.executable).resolve()), "pythonVersion": sys.version,
               "injectedConfigIndex": count, "originalConfigCount": os.environ.get("GIT_CONFIG_COUNT")}
    config = root / "admission.json"
    write_once(config, {"schemaVersion": 1, "request": request, "digest": digest(request)})
    hook = hooks / "pre-push"
    hook.write_text("#!/bin/sh\nexec " + " ".join(shlex.quote(v) for v in
                    (request["pythonBinary"], str(frozen), "_hook", str(config))) + ' "$@"\n')
    hook.chmod(0o755)
    return {"directory": str(root), "configuration": {"GIT_CONFIG_COUNT": str(count + 1),
            f"GIT_CONFIG_KEY_{count}": "core.hooksPath", f"GIT_CONFIG_VALUE_{count}": str(hooks)}}


def original_hook_environment(config):
    environment = dict(os.environ)
    index = config["injectedConfigIndex"]
    if (environment.get("GIT_CONFIG_COUNT") != str(index + 1)
            or environment.get(f"GIT_CONFIG_KEY_{index}") != "core.hooksPath"
            or environment.get(f"GIT_CONFIG_VALUE_{index}") != str(Path(config["directory"]) / "hooks")):
        raise GuardError("guard configuration environment changed")
    del environment[f"GIT_CONFIG_KEY_{index}"]
    del environment[f"GIT_CONFIG_VALUE_{index}"]
    if config["originalConfigCount"] is None:
        environment.pop("GIT_CONFIG_COUNT", None)
    else:
        environment["GIT_CONFIG_COUNT"] = config["originalConfigCount"]
    return environment


def hook(config_path, remote, url):
    config = read_record(config_path)
    root = Path(config["directory"])
    if (Path(config_path).resolve().parent != root or Path(__file__).resolve() != root / "guard.py"
            or hashlib.sha256(Path(__file__).read_bytes()).hexdigest() != config["helperDigest"]
            or str(Path(sys.executable).resolve()) != config["pythonBinary"] or sys.version != config["pythonVersion"]):
        raise GuardError("frozen guard configuration or runtime changed")
    receipt = {"accepted": False, "admissionDigest": digest(config["admission"]), "pid": os.getpid(),
               "at": datetime.now(timezone.utc).isoformat()}
    try:
        if str(Path.cwd().resolve()) != config["admission"]["directory"]:
            raise GuardError("checkout identity changed")
        limit = sum(2 * len(r["ref"].encode("utf-8")) + len(r["source"]) + len(r["expected"]) + 4
                    for r in config["admission"]["refs"])
        data = sys.stdin.buffer.read(limit + 1)
        if len(data) > limit:
            raise GuardError("update input exceeds admitted scope")
        updates, pull_requests = admit_updates(config["admission"], remote, url, data.decode("utf-8"))
        receipt["pullRequests"] = pull_requests
        environment = original_hook_environment(config)
        if config["originalPrePush"]:
            result = subprocess.run([config["originalPrePush"], remote, url], input=data, env=environment)
            if result.returncode:
                raise GuardError("original pre-push hook rejected publication")
        receipt.update(accepted=True, updates=updates)
    except Exception as error:
        receipt["error"] = "Error: Push guard: " + str(error)
        raise
    finally:
        write_once(root / ("check-" + str(uuid.uuid4()) + ".json"), receipt)


# The guard follows the latest gh-stack release (checked at tag v0.3.0, 2a49e67)
# and checks only that the command is gh-stack, not its version: --version prints
# "gh stack version VERSION" on stdout (cmd/root.go:84), and the release notifier
# writes only to stderr (cmd/root.go:56-82). push and submit pass force=true with
# per-branch --force-with-lease and fully qualified refs/heads/B:refs/heads/B
# refspecs after a best-effort tracking fetch, all branches in one push
# (cmd/push.go:111-113, cmd/submit.go:216,254); link pushes only arguments naming
# local branches, without force (cmd/link.go:447-480). All three push with
# --atomic unless --no-atomic or GH_STACK_NO_ATOMIC is given.
# internal/git/gitops.go:258-306 builds those arguments; a forced push first runs
# git -c push.pushOption=pull.stacked push and repeats without the option when
# the remote does not support push options, so the hook can see the same updates
# twice. No guarded path pushes with --no-verify or a + refspec. push and submit
# refuse a stack GitHub retargeted after its base branch was deleted
# (cmd/utils.go:1145-1156). Pushes run in the current checkout through the
# unscoped executor; the worktree-scoped executor drops GIT_CONFIG but keeps
# GIT_CONFIG_COUNT/KEY/VALUE (internal/git/git.go:49-69). The flags are --auto,
# --open, --remote and --no-atomic for submit, --remote and --no-atomic for push,
# and --base, --open, --remote and --no-atomic for link; the accepted commands
# below pass no --no-atomic. link takes a stack or PR number, branch, or PR
# URL, then one or more branch-or-PR arguments (cmd/link.go:29,77); a number
# naming a stack appends to it, otherwise every PR the stack holds must be listed
# (cmd/link.go:175-196,666-693). Its base corrections only warn on failure
# (cmd/link.go:740-783).
GH_STACK_IDENTITY = re.compile(r"gh stack version \S+")
POSITIVE_NUMBER = re.compile(r"[1-9][0-9]*")
# What Go's strconv.Atoi parses; link tries such an argument as a PR number first
# (cmd/link.go:560-573), so a branch named like one is not a safe branch argument.
ATOI_NUMBER = re.compile(r"[+-]?[0-9]+")


def validate_native_command(command, admission):
    if len(command) < 3 or Path(command[0]).name != "gh" or command[1] != "stack":
        raise GuardError("run requires an explicit native gh stack command")
    tail = command[2:]
    if tail == ["submit", "--auto", "--remote", admission["remote"]]:
        return
    if tail == ["push", "--remote", admission["remote"]]:
        return
    # link STACK-OR-PR BRANCH-OR-PR... --remote REMOTE: each later argument is a
    # PR number or an admitted branch that cannot be read as a flag or a number. A number
    # that also names a local branch is pushed, and the hook refuses it unless
    # that branch is admitted.
    admitted = {r["ref"] for r in admission["refs"]}
    targets = tail[1:-2]
    if (len(tail) >= 5 and tail[0] == "link" and tail[-2:] == ["--remote", admission["remote"]]
            and POSITIVE_NUMBER.fullmatch(tail[1]) and len(set(targets)) == len(targets)
            and all(POSITIVE_NUMBER.fullmatch(argument)
                    or (not argument.startswith("-") and not ATOI_NUMBER.fullmatch(argument)
                        and "refs/heads/" + argument in admitted)
                    for argument in targets[1:])):
        return
    raise GuardError("unsupported native publication command; do not bypass hooks")


def main(argv=None):
    if sys.version_info < (3, 11):
        raise GuardError("Python 3.11 or newer is required")
    argv = sys.argv[1:] if argv is None else argv
    if argv and argv[0] == "_hook":
        if len(argv) != 4:
            raise GuardError("invalid hook invocation")
        hook(*argv[1:])
        return 0
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("prepare", "run"))
    parser.add_argument("--admission", required=True, help="JSON file, or - for stdin; keep outside tracked/untracked work")
    split = argv.index("--") if "--" in argv else len(argv)
    command = argv[split + 1:]
    argv = argv[:split]
    args = parser.parse_args(argv)
    raw = sys.stdin.buffer.read() if args.admission == "-" else Path(args.admission).read_bytes()
    admission = validate_admission(load_json(raw))
    if args.operation == "prepare" and command:
        raise GuardError("prepare does not execute a command")
    if args.operation == "run":
        validate_native_command(command, admission)
        try:
            version = subprocess.run([command[0], "stack", "--version"], capture_output=True, text=True)
        except OSError:
            version = None
        if version is None or version.returncode or not GH_STACK_IDENTITY.fullmatch(version.stdout.strip()):
            raise GuardError("command is not the gh-stack extension")
    prepared = prepare(admission)
    if args.operation == "prepare":
        print(json.dumps(prepared))
        return 0
    result = subprocess.run(command, cwd=admission["directory"], env={**os.environ, **prepared["configuration"]})
    write_once(Path(prepared["directory"]) / "run.json", {"command": command, "exitCode": result.returncode})
    print(json.dumps({"guardDirectory": prepared["directory"], "exitCode": result.returncode}), file=sys.stderr)
    return result.returncode if result.returncode >= 0 else 128 - result.returncode


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print("Error: Push guard: " + str(error), file=sys.stderr)
        sys.exit(1)
