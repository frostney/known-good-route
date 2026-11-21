import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import urllib.parse

SKILL = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("stack_push_guard", SKILL / "scripts/stack_push_guard.py")
guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guard)


class ValidationTests(unittest.TestCase):
    def setUp(self):
        self.admission = {"directory": "/fixture", "remote": "upstream", "url": "/remote",
                          "refs": [{"ref": "refs/heads/feature/naïve-key", "source": "a" * 40, "expected": "b" * 40}]}
        row = self.admission["refs"][0]
        self.line = f'{row["ref"]} {row["source"]} {row["ref"]} {row["expected"]}\n'

    def test_nested_unicode_refs_and_sha256_are_not_fixture_specific(self):
        self.assertEqual(len(guard.validate_updates(self.admission, "upstream", "/remote", self.line)), 1)
        c = copy.deepcopy(self.admission)
        c["refs"][0].update(source="a" * 64, expected="0" * 64)
        self.assertEqual(guard.validate_admission(c), c)

    def test_bad_scope_or_object_cannot_be_admitted(self):
        for field, value in [("ref", "refs/tags/release"), ("ref", "refs/heads/.hidden"),
                             ("ref", "refs/heads/a..b"), ("ref", "refs/heads/a\nb"),
                             ("source", "0" * 40), ("source", "HEAD"), ("expected", "f" * 64)]:
            with self.subTest(field=field, value=value):
                c = copy.deepcopy(self.admission)
                c["refs"][0][field] = value
                with self.assertRaises(guard.GuardError):
                    guard.validate_admission(c)
        c = copy.deepcopy(self.admission)
        c["refs"] *= 2
        with self.assertRaises(guard.GuardError):
            guard.validate_admission(c)

    def test_corrupt_redirected_deleted_or_duplicated_updates_fail(self):
        for text in ["invalid\n", self.line * 2, self.line.replace("feature/naïve-key", "other", 1),
                     self.line.replace("a" * 40, "0" * 40), self.line.replace("b" * 40, "c" * 40)]:
            with self.subTest(text=text), self.assertRaises(guard.GuardError):
                guard.validate_updates(self.admission, "upstream", "/remote", text)
        for remote, url in [("origin", "/remote"), ("upstream", "/other")]:
            with self.assertRaises(guard.GuardError):
                guard.validate_updates(self.admission, remote, url, self.line)
        self.assertEqual(guard.validate_updates(self.admission, "upstream", "/remote", ""), [])

    def test_no_arbitrary_commands_or_hook_bypass_in_run(self):
        valid = ["gh", "stack", "submit", "--auto", "--remote", "upstream"]
        guard.validate_native_command(valid, self.admission)
        guard.validate_native_command(["gh", "stack", "push", "--remote", "upstream"], self.admission)
        guard.validate_native_command(["gh", "stack", "link", "12", "feature/naïve-key", "--remote", "upstream"], self.admission)
        for command in [valid + ["--no-verify"], ["sh", "-c", "anything"],
                        ["gh", "stack", "merge"], ["gh", "stack", "link", "12", "unapproved", "--remote", "upstream"],
                        valid[:-1] + ["other"], ["gh", "stack", "push", "--remote", "other"],
                        ["gh", "stack", "push", "--remote", "upstream", "--no-verify"]]:
            with self.subTest(command=command), self.assertRaises(guard.GuardError):
                guard.validate_native_command(command, self.admission)

    def test_link_accepts_several_numbers_or_admitted_branches(self):
        for targets in [["12", "13"], ["1639", "1644", "1645", "1649", "1656"], ["7", "48", "feature/naïve-key"],
                        ["12", "feature/naïve-key", "13"]]:
            with self.subTest(targets=targets):
                guard.validate_native_command(["gh", "stack", "link", *targets, "--remote", "upstream"], self.admission)

    def test_malformed_link_is_refused(self):
        flagged = copy.deepcopy(self.admission)
        flagged["refs"].append({"ref": "refs/heads/--open", "source": "c" * 40, "expected": "d" * 40})
        numeric = copy.deepcopy(self.admission)
        numeric["refs"] += [{"ref": "refs/heads/" + name, "source": "c" * 40, "expected": "d" * 40}
                            for name in ("+13", "013")]
        for targets, admission in [
                (["12"], self.admission), (["12", "13", "12"], self.admission),
                (["12", "feature/naïve-key", "unapproved"], self.admission),
                (["feature/naïve-key", "12"], self.admission), (["0", "12"], self.admission),
                (["012", "13"], self.admission), (["12", "²"], self.admission),
                (["12", "https://github.com/github/gh-stack/pull/13"], self.admission),
                (["12", "13", "--open"], self.admission), (["12", "13", "--base", "main"], self.admission),
                (["12", "--open"], flagged), (["12", "1٣"], self.admission), (["12", "13x"], self.admission),
                (["12", "+13"], numeric), (["12", "013"], numeric)]:
            with self.subTest(targets=targets):
                with self.assertRaises(guard.GuardError):
                    guard.validate_native_command(["gh", "stack", "link", *targets, "--remote", "upstream"], admission)
        for command in [["gh", "stack", "link", "12", "13"], ["gh", "stack", "link", "12", "13", "--remote", "other"],
                        ["gh", "stack", "link", "12", "13", "--remote", "upstream", "--no-verify"],
                        ["gh", "stack", "link", "--remote", "upstream", "12", "13"]]:
            with self.subTest(command=command), self.assertRaises(guard.GuardError):
                guard.validate_native_command(command, self.admission)

    def test_duplicate_json_and_incomplete_config_fail(self):
        with self.assertRaises(guard.GuardError):
            guard.load_json('{"remote":"origin","remote":"elsewhere"}')
        for env in [{"GIT_CONFIG_COUNT": "01"}, {"GIT_CONFIG_COUNT": "1"}, {"GIT_CONFIG_COUNT": "-1"}]:
            with self.assertRaises(guard.GuardError):
                guard.config_count(env)


class FakeGitHub:
    """Answers the guard's two GitHub lookups from fixed pull requests and run counts."""

    def __init__(self, pulls=(), runs=None, fail=None, full_name="example-org/app"):
        self.pulls, self.runs, self.fail, self.calls = list(pulls), runs or {}, fail, []
        self.full_name = full_name

    def __call__(self, host, path):
        self.calls.append((host, path))
        if self.fail:
            raise guard.GuardError(self.fail)
        if "?" not in path:
            return {"full_name": self.full_name}
        if "/pulls?" in path:
            # Like GitHub, an owner other than the current one matches nothing.
            owner, head = urllib.parse.unquote(path.split("head=", 1)[1]).split(":", 1)
            return [p for p in self.pulls if p["head"]["ref"] == head
                    and owner.lower() == self.full_name.split("/")[0].lower()]
        found = self.runs.get(path.split("head_sha=", 1)[1], [])
        if isinstance(found, int):  # that many finished, passed runs of one workflow
            found = [run() for _ in range(found)]
        return {"total_count": len(found), "workflow_runs": found}


def run(status="completed", conclusion="success", workflow=1):
    return {"status": status, "conclusion": conclusion if status == "completed" else None, "workflow_id": workflow}


def pull(number, branch, sha, draft=True, repository="example-org/app"):
    return {"number": number, "draft": draft, "head": {"ref": branch, "sha": sha, "repo": {"full_name": repository}}}


class RewriteTests(unittest.TestCase):
    def setUp(self):
        self.admission = guard.validate_admission({
            "directory": "/fixture", "remote": "origin", "url": "https://github.com/example-org/app.git",
            "refs": [{"ref": "refs/heads/stack/one", "source": "a" * 40, "expected": "b" * 40},
                     {"ref": "refs/heads/stack/two", "source": "c" * 40, "expected": "d" * 40}]})

    def with_rewrite(self, *refs):
        return guard.validate_admission({**self.admission, "rewrite": [
            {"ref": ref, "reason": "final rebase before merging the whole stack"} for ref in refs]})

    def test_draft_pull_requests_without_runs_pass(self):
        github = FakeGitHub([pull(12, "stack/one", "b" * 40), pull(13, "stack/two", "d" * 40)])
        observed = guard.check_rewrites(self.admission, github)
        self.assertEqual([o["pullRequest"] for o in observed], [12, 13])
        self.assertEqual({host for host, _ in github.calls}, {"github.com"})
        self.assertEqual(github.calls[0][1], "repos/example-org/app")
        self.assertIn("repos/example-org/app/pulls?state=open&per_page=100&head=example-org%3Astack%2Fone", github.calls[1][1])

    def test_a_transferred_repository_is_checked_under_its_current_owner(self):
        github = FakeGitHub([pull(12, "stack/one", "b" * 40, draft=False, repository="example-renamed/app")],
                            full_name="example-renamed/app")
        with self.assertRaisesRegex(guard.GuardError, "#12"):
            guard.check_rewrites(self.admission, github)

    def test_branch_names_are_encoded_and_other_heads_ignored(self):
        admission = guard.validate_admission({**self.admission, "refs": [
            {"ref": "refs/heads/stack/naïve+&#", "source": "a" * 40, "expected": "b" * 40}]})
        github = FakeGitHub([pull(12, "stack/naïve+&#", "b" * 40, draft=False)])
        with self.assertRaisesRegex(guard.GuardError, "#12"):
            guard.check_rewrites(admission, github)
        self.assertTrue(github.calls[1][1].endswith("head=example-org%3Astack%2Fna%C3%AFve%2B%26%23"))
        fork = FakeGitHub([pull(12, "stack/naïve+&#", "b" * 40, draft=False, repository="example-fork/app")])
        self.assertEqual(guard.check_rewrites(admission, fork), [])

    def test_ready_pull_request_is_refused(self):
        github = FakeGitHub([pull(12, "stack/one", "b" * 40, draft=False), pull(13, "stack/two", "d" * 40)])
        with self.assertRaisesRegex(guard.GuardError, r"1 open pull request\(s\): #12 \(stack/one: ready for review\)"):
            guard.check_rewrites(self.admission, github)

    def test_a_draft_whose_ci_has_not_passed_may_move(self):
        # Not frozen: its CI is queued, running, failed or cancelled, and a draft has no review yet.
        for runs in ([run("queued")], [run("in_progress"), run()], [run(conclusion="failure")],
                     [run(conclusion="cancelled")], [run(), run(conclusion="failure", workflow=2)]):
            with self.subTest(runs=runs):
                github = FakeGitHub([pull(12, "stack/one", "b" * 40), pull(13, "stack/two", "d" * 40)],
                                    runs={"b" * 40: runs})
                observed = guard.check_rewrites(self.admission, github)
                self.assertEqual([(o["pullRequest"], o["workflowRuns"], o["ciPassed"]) for o in observed],
                                 [(12, len(runs), False), (13, 0, False)])

    def test_a_draft_whose_ci_passed_is_frozen_and_the_cost_is_named(self):
        # A cancelled duplicate beside a passed run of the same workflow keeps it frozen.
        github = FakeGitHub([pull(12, "stack/one", "b" * 40), pull(13, "stack/two", "d" * 40, draft=False)],
                            runs={"b" * 40: [run(), run(conclusion="cancelled"), run(conclusion="skipped", workflow=2)],
                                  "d" * 40: [run("in_progress")]})
        with self.assertRaises(guard.GuardError) as caught:
            guard.check_rewrites(self.admission, github)
        message = str(caught.exception)
        self.assertIn("#12 (stack/one: draft, CI passed on its head, 3 workflow runs on its head)", message)
        self.assertIn("#13 (stack/two: ready for review, 1 workflow runs on its head)", message)
        self.assertIn("restart CI on 2 of them", message)

    def test_incomplete_or_paged_run_lists_refuse(self):
        for runs, error in (({"total_count": 1}, "no workflow runs"),
                            ({"total_count": 101, "workflow_runs": [run()] * 100}, "more than one page"),
                            ({"total_count": 1, "workflow_runs": [{"status": "completed"}]}, "incomplete workflow run")):
            with self.subTest(error=error), self.assertRaisesRegex(guard.GuardError, error):
                guard.ci_state(runs, 12)

    def test_listed_rewrite_passes_without_a_lookup(self):
        github = FakeGitHub([pull(12, "stack/one", "b" * 40, draft=False)], runs={"b" * 40: 4})
        self.assertEqual(guard.check_rewrites(self.with_rewrite("refs/heads/stack/one"), github), [])
        self.assertEqual(len(github.calls), 2)  # the repository, then stack/two, which has no open pull request
        with self.assertRaisesRegex(guard.GuardError, "#12"):
            guard.check_rewrites(self.with_rewrite("refs/heads/stack/two"), github)

    def test_invalid_rewrite_entries(self):
        for rewrite in [[{"ref": "refs/heads/stack/three", "reason": "not admitted"}],
                        [{"ref": "refs/heads/stack/one", "reason": "  "}],
                        [{"ref": "refs/heads/stack/one"}], [{"ref": ["refs/heads/stack/one"], "reason": "x"}],
                        [{"ref": "refs/heads/stack/one", "reason": "x"}] * 2, [], "refs/heads/stack/one"]:
            with self.subTest(rewrite=rewrite), self.assertRaises(guard.GuardError):
                guard.validate_admission({**self.admission, "rewrite": rewrite})
        with self.assertRaisesRegex(guard.GuardError, "invalid admission fields"):
            guard.validate_admission({**self.admission, "rewrites": []})

    def test_lookup_failure_refuses(self):
        with self.assertRaisesRegex(guard.GuardError, "HTTP 502"):
            guard.check_rewrites(self.admission, FakeGitHub(fail="GitHub lookup failed: HTTP 502"))
        incomplete = FakeGitHub([{"number": 12, "head": {"ref": "stack/one", "sha": "b" * 40}}])
        with self.assertRaisesRegex(guard.GuardError, "incomplete pull request"):
            guard.check_rewrites(self.admission, incomplete)
        with self.assertRaisesRegex(guard.GuardError, "#12 head is"):
            guard.check_rewrites(self.admission, FakeGitHub([pull(12, "stack/one", "e" * 40)]))
        crowded = FakeGitHub([pull(n, "stack/one", "b" * 40) for n in range(1, 101)])
        with self.assertRaisesRegex(guard.GuardError, "more than one page"):
            guard.check_rewrites(self.admission, crowded)
        with self.assertRaisesRegex(guard.GuardError, "names no GitHub repository"):
            guard.check_rewrites({**self.admission, "url": "/srv/git/app.git"}, FakeGitHub())

    def test_the_hook_checks_again_at_the_push(self):
        line = "refs/heads/stack/one " + "a" * 40 + " refs/heads/stack/one " + "b" * 40 + "\n"
        url = self.admission["url"]
        github = FakeGitHub([pull(12, "stack/one", "b" * 40)])
        self.assertEqual(len(guard.check_rewrites(self.admission, github)), 1)
        # Marked ready after the guard was prepared.
        github.pulls[0]["draft"] = False
        with self.assertRaisesRegex(guard.GuardError, "#12"):
            guard.admit_updates(self.admission, "origin", url, line, github)
        updates, observed = guard.admit_updates(self.with_rewrite("refs/heads/stack/one"), "origin", url, line, github)
        self.assertEqual((len(updates), observed), (1, []))
        # Only the refs actually pushed are looked up; an empty push needs none.
        quiet = FakeGitHub(fail="no lookup expected")
        self.assertEqual(guard.admit_updates(self.admission, "origin", url, "", quiet), ([], []))

    def test_missing_gh_refuses(self):
        with tempfile.TemporaryDirectory() as empty, mock.patch.dict(os.environ, {"PATH": empty}):
            with self.assertRaisesRegex(guard.GuardError, "gh is not installed"):
                guard.github_api("github.com", "repos/example-org/app/pulls")

    def test_new_or_unchanged_branches_need_no_lookup(self):
        admission = guard.validate_admission({**self.admission, "url": "/not/github", "refs": [
            {"ref": "refs/heads/stack/one", "source": "a" * 40, "expected": "0" * 40},
            {"ref": "refs/heads/stack/two", "source": "d" * 40, "expected": "d" * 40}]})
        github = FakeGitHub(fail="no lookup expected")
        self.assertEqual(guard.check_rewrites(admission, github), [])
        self.assertEqual(github.calls, [])

    def test_remote_url_forms(self):
        for url, expected in [("https://github.com/example-org/app.git", ("github.com", "example-org/app")),
                              ("https://token@github.example.com/example-org/app", ("github.example.com", "example-org/app")),
                              ("git@github.com:example-org/my.app.git", ("github.com", "example-org/my.app")),
                              ("ssh://git@github.com:22/example-org/app.git/", ("github.com", "example-org/app")),
                              ("ssh://git@ssh.github.com:443/example_org/app.git", ("github.com", "example_org/app"))]:
            with self.subTest(url=url):
                self.assertEqual(guard.github_repository(url), expected)
        for url in ["/srv/git/app.git", "file:///srv/app.git", "https://github.com/example-org", "https://github.com/example-org/app/extra"]:
            with self.subTest(url=url), self.assertRaises(guard.GuardError):
                guard.github_repository(url)


class StandaloneTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="kgr-portable-guard-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        # Only the skill is copied. Neither evals nor npm dependencies exist here.
        shutil.copytree(SKILL, self.root / "installed skill")
        self.helper = self.root / "installed skill/scripts/stack_push_guard.py"
        self.repo = self.root / "repository"
        self.remote = self.root / "remote.git"
        self.repo.mkdir()
        self.git("init", "--bare", "--initial-branch=main", str(self.remote))
        self.git("init", "--initial-branch=main")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("commit", "--allow-empty", "-m", "initial")
        self.head = self.git("rev-parse", "HEAD")
        self.ref = "refs/heads/feature/portable-guard"
        self.git("branch", self.ref.removeprefix("refs/heads/"))
        self.git("remote", "add", "origin", str(self.remote))
        self.admission = {"directory": str(self.repo), "remote": "origin", "url": str(self.remote),
                          "refs": [{"ref": self.ref, "source": self.head, "expected": "0" * 40}]}

    def git(self, *args, environment=None, check=True):
        result = subprocess.run(["git", *args], cwd=self.repo, env=environment, capture_output=True, text=True)
        if check and result.returncode:
            self.fail(result.stderr)
        return result.stdout.strip() if check else result

    def prepare(self, environment=None, admission=None):
        result = subprocess.run([sys.executable, str(self.helper), "prepare", "--admission", "-"],
                                input=json.dumps(admission or self.admission), capture_output=True, text=True, env=environment)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def push(self, prepared, environment=None):
        return self.git("push", "origin", f"{self.ref}:{self.ref}",
                        environment={**(environment or os.environ), **prepared["configuration"]}, check=False)

    def test_standalone_copy_pushes_without_bun_or_repository_modules(self):
        prepared = self.prepare()
        result = self.push(prepared)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.git("ls-remote", "--heads", "origin", self.ref), f"{self.head}\t{self.ref}")
        receipt = json.loads(next(Path(prepared["directory"]).glob("check-*.json")).read_text())
        self.assertTrue(receipt["accepted"])
        self.assertEqual(receipt["updates"][0]["source"], self.head)

    def test_actual_sha256_and_unicode_ref_with_a_non_origin_remote(self):
        self.repo = self.root / "sha256 repository"
        self.remote = self.root / "sha256 remote.git"
        self.repo.mkdir()
        self.git("init", "--bare", "--object-format=sha256", "--initial-branch=main", str(self.remote))
        self.git("init", "--object-format=sha256", "--initial-branch=main")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("commit", "--allow-empty", "-m", "sha256 fixture")
        self.head = self.git("rev-parse", "HEAD")
        self.ref = "refs/heads/feature/naïve-\u0085-key"
        self.git("branch", self.ref.removeprefix("refs/heads/"))
        self.git("remote", "add", "upstream", str(self.remote))
        self.admission = {"directory": str(self.repo), "remote": "upstream", "url": str(self.remote),
                          "refs": [{"ref": self.ref, "source": self.head, "expected": "0" * 64}]}
        prepared = self.prepare()
        result = self.git("push", "upstream", f"{self.ref}:{self.ref}",
                          environment={**os.environ, **prepared["configuration"]}, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.head), 64)
        self.assertEqual(self.git("ls-remote", "--heads", "upstream", self.ref), f"{self.head}\t{self.ref}")

    def test_preserves_existing_hook_environment_and_forwards_other_hooks(self):
        # Keep the configured hook directory in Git metadata so it is not dirty.
        hooks = self.repo / ".git" / "custom hooks"
        hooks.mkdir()
        self.git("config", "core.hooksPath", str(hooks))
        observed = self.root / "observed-hook-config"
        other = self.root / "other-hook"
        pre = hooks / "pre-push"
        pre.write_text(f"#!/bin/sh\ngit config --get test.retained > {shlex.quote(str(observed))}\ngit config --get core.hooksPath >> {shlex.quote(str(observed))}\ncat >/dev/null\n")
        pre.chmod(0o755)
        commit_hook = hooks / "pre-commit"
        commit_hook.write_text(f"#!/bin/sh\nprintf yes > {shlex.quote(str(other))}\n")
        commit_hook.chmod(0o755)
        env = {**os.environ, "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "test.retained", "GIT_CONFIG_VALUE_0": "retained"}
        prepared = self.prepare(env)
        result = self.push(prepared, env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(observed.read_text(), f"retained\n{hooks}\n")
        self.git("hook", "run", "pre-commit", environment={**env, **prepared["configuration"]})
        self.assertEqual(other.read_text(), "yes")
        self.assertEqual(self.git("config", "core.hooksPath"), str(hooks))
        self.assertNotIn("GIT_CONFIG_VALUE_0", prepared["configuration"])

    def moved_layer(self):
        """The branch exists on a GitHub-named remote and moves to a new local commit."""
        self.git("remote", "add", "github", "https://github.com/example-org/app.git")
        self.git("commit", "--allow-empty", "-m", "rebased layer")
        self.git("branch", "--force", self.ref.removeprefix("refs/heads/"), "HEAD")
        source = self.git("rev-parse", "HEAD")
        return {"directory": str(self.repo), "remote": "github", "url": "https://github.com/example-org/app.git",
                "refs": [{"ref": self.ref, "source": source, "expected": self.head}]}

    def test_prepare_refuses_a_reviewed_layer_and_admits_a_listed_rewrite(self):
        admission = self.moved_layer()
        github = FakeGitHub([pull(7, "feature/portable-guard", self.head, draft=False)], runs={self.head: 2})
        with self.assertRaisesRegex(guard.GuardError, r"#7 .*restart CI on 1 of them"):
            guard.prepare(admission, github)
        self.assertFalse((self.repo / ".git/kgr-push-guards").exists())
        admission["rewrite"] = [{"ref": self.ref, "reason": "final rebase before merging the whole stack"}]
        prepared = guard.prepare(admission, github)
        record = json.loads((Path(prepared["directory"]) / "admission.json").read_text())["request"]
        self.assertEqual(record["admission"]["rewrite"], admission["rewrite"])
        self.assertEqual(record["pullRequests"], [])

    def test_prepare_moves_a_draft_whose_ci_failed_and_names_the_restarted_runs(self):
        admission = self.moved_layer()
        github = FakeGitHub([pull(7, "feature/portable-guard", self.head)], runs={self.head: [run(conclusion="failure")]})
        with mock.patch("sys.stderr", new_callable=io.StringIO) as stderr:
            prepared = guard.prepare(admission, github)
        record = json.loads((Path(prepared["directory"]) / "admission.json").read_text())["request"]
        self.assertEqual([(o["pullRequest"], o["ciPassed"]) for o in record["pullRequests"]], [(7, False)])
        self.assertIn("moving draft #7 restarts its CI (1 workflow runs", stderr.getvalue())

    def test_prepare_refuses_when_gh_is_unavailable(self):
        admission = self.moved_layer()
        only_git = self.root / "only-git"
        only_git.mkdir()
        (only_git / "git").symlink_to(shutil.which("git"))
        result = subprocess.run([sys.executable, str(self.helper), "prepare", "--admission", "-"],
                                input=json.dumps(admission), capture_output=True, text=True,
                                env={**os.environ, "PATH": str(only_git)})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("gh is not installed", result.stderr)
        self.assertFalse((self.repo / ".git/kgr-push-guards").exists())

    def test_hook_refuses_an_existing_branch_admitted_as_new(self):
        # Claiming a branch is new skips the lookup, so the hook must hold the claim.
        self.git("push", "--quiet", "origin", f"{self.ref}:{self.ref}")
        self.git("commit", "--allow-empty", "-m", "rebased layer")
        self.git("branch", "--force", self.ref.removeprefix("refs/heads/"), "HEAD")
        self.admission["refs"][0]["source"] = self.git("rev-parse", "HEAD")
        result = self.push(self.prepare())
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("advertised remote head differs from admission", result.stderr)
        self.assertEqual(self.git("ls-remote", "--heads", "origin", self.ref), f"{self.head}\t{self.ref}")

    def test_frozen_helper_change_rejects_before_remote_update(self):
        prepared = self.prepare()
        frozen = Path(prepared["directory"]) / "guard.py"
        frozen.write_text(frozen.read_text() + "\n# changed after admission\n")
        result = self.push(prepared)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("frozen guard configuration or runtime changed", result.stderr)
        self.assertEqual(self.git("ls-remote", "--heads", "origin", self.ref), "")

    def test_changed_admission_and_symlink_replacement_are_rejected(self):
        for mode in ["content", "symlink"]:
            prepared = self.prepare()
            config = Path(prepared["directory"]) / "admission.json"
            value = json.loads(config.read_text())
            if mode == "content":
                value["request"]["admission"]["remote"] = "elsewhere"
                config.write_text(json.dumps(value))
            else:
                target = config.with_suffix(".copy")
                target.write_text(config.read_text())
                config.unlink()
                config.symlink_to(target)
            result = self.push(prepared)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(self.git("ls-remote", "--heads", "origin", self.ref), "")

    def test_dirty_checkout_and_changed_push_url_do_not_prepare(self):
        for mode in ["dirty", "push-url"]:
            if mode == "dirty":
                (self.repo / "unrelated").write_text("user work")
            else:
                (self.repo / "unrelated").unlink()
                self.git("remote", "set-url", "--push", "origin", str(self.root / "another.git"))
            result = subprocess.run([sys.executable, str(self.helper), "prepare", "--admission", "-"],
                                    input=json.dumps(self.admission), capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((self.repo / ".git/kgr-push-guards").exists())

    def run_with_native_cli(self, version_output, arguments=("submit", "--auto", "--remote", "origin"), version_exit=0):
        # Native argv routing is tested here with a tiny gh stand-in; live tests
        # separately exercise the installed official extension against GitHub.
        gh = self.root / "gh"
        gh.write_text(f'#!/bin/sh\nif [ "$2" = "--version" ]; then printf %s {shlex.quote(version_output)}; exit {version_exit}; fi\n'
                      f'exec git push origin {shlex.quote(self.ref + ":" + self.ref)}\n')
        gh.chmod(0o755)
        return subprocess.run([sys.executable, str(self.helper), "run", "--admission", "-", "--", str(gh),
                               "stack", *arguments],
                              input=json.dumps(self.admission), capture_output=True, text=True)

    def test_run_cli_preserves_guard_and_child_exit_without_an_sdk(self):
        # Any gh-stack version is accepted; the behaviour was checked at 0.3.0.
        for version in ["0.2.1", "0.3.0"]:
            with self.subTest(version=version):
                self.git("push", "--quiet", "origin", "--delete", self.ref, check=False)
                result = self.run_with_native_cli(f"gh stack version {version}\n")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.git("ls-remote", "--heads", "origin", self.ref), f"{self.head}\t{self.ref}")
        receipts = list((self.repo / ".git/kgr-push-guards").glob("*/run.json"))
        self.assertEqual(len(receipts), 2)
        self.assertEqual([json.loads(r.read_text())["exitCode"] for r in receipts], [0, 0])

    def test_run_cli_routes_a_multi_argument_link(self):
        branch = self.ref.removeprefix("refs/heads/")
        result = self.run_with_native_cli("gh stack version 0.2.1\n", ("link", "1639", "1644", branch, "--remote", "origin"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.git("ls-remote", "--heads", "origin", self.ref), f"{self.head}\t{self.ref}")
        receipt = json.loads(next((self.repo / ".git/kgr-push-guards").glob("*/run.json")).read_text())
        self.assertEqual(receipt["command"][2:], ["link", "1639", "1644", branch, "--remote", "origin"])

    def test_command_that_is_not_gh_stack_runs_nothing(self):
        for output, code in [("gh version 2.83.0 (2026-10-01)\n", 0), ("gh stack version \n", 0),
                             ("gh stack version 0.2.1\nanother line\n", 0), ("gh-stack 0.2.1\n", 0),
                             ("", 0), ('unknown command "stack" for "gh"\n', 1)]:
            with self.subTest(output=output, code=code):
                self.git("push", "--quiet", "origin", "--delete", self.ref, check=False)
                shutil.rmtree(self.repo / ".git/kgr-push-guards", ignore_errors=True)
                result = self.run_with_native_cli(output, version_exit=code)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("command is not the gh-stack extension", result.stderr)
                self.assertEqual(self.git("ls-remote", "--heads", "origin", self.ref), "")
                self.assertFalse((self.repo / ".git/kgr-push-guards").exists())


if __name__ == "__main__":
    unittest.main()
