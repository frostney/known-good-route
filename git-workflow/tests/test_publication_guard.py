import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest

HELPER = Path(__file__).resolve().parents[1] / "scripts/publication_guard.py"
PRIVATE = "example-private/secret-repo"
PUBLIC = "octocat/Hello-World"
SHA = "3f786850e387550fdab836ed7e6dc881de23001b"
GONE = "example-gone/vanished"  # Answers 404, so a URL to it counts as private.
SPEC = importlib.util.spec_from_file_location("publication_guard", HELPER)
publication_guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publication_guard)

# The guard runs as an invented user; its home is outside /Users and /home so
# the home directory and the username rules can fail separately.
HOME = "/srv/example-home"
USER = "example-user"
TMPDIR = "/private/var/example-tmp/T"
# Built from parts so that committing this file through the guard keeps them as written.
AGENT_TMP = "/tmp/" + "claude-1000"
MAC_TMP = "/var/" + "folders/ab/cd123ef/T"
ENCODED = "-" + "Users-example-user-Documents-Projects-example-lifecycle-example-project--claude-worktrees-example-worktree"
SESSION = f"/private{AGENT_TMP}/{ENCODED}/0b6f5a2e-1c3d-4e5f-8a9b-0c1d2e3f4a5b"

# Repositories absent from this table answer 404; example-flaky answers 502.
FAKE_GH = textwrap.dedent(f"""\
    #!{sys.executable}
    import json, os, sys
    args = sys.argv[1:]
    with open(os.environ["FAKE_GH_LOG"], "a") as log:
        log.write(" ".join(args) + "\\n")
    visibility = {{"example-private/secret-repo": "private", "octocat/hello-world": "public",
                   "example-public/open-repo": "public"}}
    if args[:2] == ["repo", "view"]:
        print(os.environ.get("FAKE_GH_REPO", "octocat/Hello-World"))
    elif args[:2] == ["api", "user"]:
        print("example-user")
    elif args[:3] == ["api", "--paginate", "user/orgs"]:
        print("example-private")
    elif args[0] == "api" and args[1].startswith("repos/"):
        slug = args[1].removeprefix("repos/").lower()
        if slug.startswith("example-flaky/"):
            sys.exit(print("gh: Bad Gateway (HTTP 502)", file=sys.stderr) or 1)
        if slug not in visibility:
            sys.exit(print("gh: Not Found (HTTP 404)", file=sys.stderr) or 1)
        body = {{"visibility": visibility[slug], "private": visibility[slug] != "public"}}
        print(body["visibility"] if "--jq" in args else json.dumps(body))
    else:
        sys.exit(print("unexpected fake gh call: " + repr(args), file=sys.stderr) or 1)
    """)


class PublicationGuardTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="kgr-publication-guard-")
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        bin_dir = self.base / "bin"
        bin_dir.mkdir()
        (bin_dir / "gh").write_text(FAKE_GH)
        (bin_dir / "gh").chmod(0o755 | stat.S_IXUSR)
        self.log = self.base / "gh.log"
        self.env = {**os.environ, "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}", "FAKE_GH_LOG": str(self.log)}
        self.guard_env = {key: value for key, value in self.env.items() if key not in {"TEMP", "TMP", "USERPROFILE"}}
        self.guard_env.update({"HOME": HOME, "TMPDIR": TMPDIR, **{name: USER for name in ("LOGNAME", "USER", "LNAME", "USERNAME")}})
        self.repo = self.base / "repository"
        self.repo.mkdir()
        self.git("init", "--initial-branch=main")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("commit", "--allow-empty", "-m", "initial")

    def git(self, *args):
        result = subprocess.run(["git", *args], cwd=self.repo, capture_output=True, text=True, env=self.env)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def guard(self, *args, repo=PUBLIC):
        result = subprocess.run([sys.executable, str(HELPER), *args, "--repo", repo], cwd=self.repo,
                                capture_output=True, text=True, env=self.guard_env)
        self.assertEqual(result.returncode, 0, result.stderr)
        if repo == PUBLIC:
            self.assertNotIn("secret-repo", result.stdout)
            self.assertNotIn(USER, result.stdout)
        return result.stdout

    def stage(self, files):
        for name, content in files.items():
            path = self.repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content if isinstance(content, str) else json.dumps(content, indent=2) + "\n")
        self.git("add", *files)

    def staged(self, name):
        return self.git("show", f":{name}")

    def staged_json(self, name):
        return json.loads(self.staged(name))

    def write(self, name, text):
        path = self.base / name
        path.write_text(text)
        return path

    def test_private_destination_is_a_no_op(self):
        other = f"https://github.com/{GONE}/pull/2"
        notes = f"See {PRIVATE}#4 and {other} in /Users/{USER}/notes.md.\n"
        self.stage({"a.json": {"repo": PRIVATE, "pr": 4, "from": other}, "notes.md": notes})
        message = self.write("message", f"fix: sync {PRIVATE} from {other} via {SESSION}/out.txt\n")
        output = self.guard("staged", "--message-file", str(message), repo=PRIVATE)
        self.assertIn("not public", output)
        self.assertEqual(self.staged_json("a.json"), {"repo": PRIVATE, "pr": 4, "from": other})
        self.assertEqual(self.staged("notes.md"), notes)
        self.assertEqual(message.read_text(), f"fix: sync {PRIVATE} from {other} via {SESSION}/out.txt\n")
        self.assertEqual(self.log.read_text().count("repos/"), 1)

    def test_public_reference_is_untouched(self):
        text = (f"{PUBLIC} and {PUBLIC}#12 and https://github.com/{PUBLIC}/pull/3\n"
                f"[link](https://github.com/{PUBLIC}/issues/7), https://github.com/{PUBLIC}.git and "
                "https://github.com/orgs/example-private/projects/1\n")
        self.stage({"notes.md": text, "a.json": {"repo": PUBLIC, "pr": 12, "head": SHA}})
        self.assertIn("nothing to rewrite", self.guard("staged"))
        self.assertEqual(self.staged("notes.md"), text)
        self.assertEqual(self.staged_json("a.json"), {"repo": PUBLIC, "pr": 12, "head": SHA})

    def test_private_slug_in_json_maps_to_a_stable_placeholder_across_files_and_runs(self):
        self.stage({"one.json": {"repo": PRIVATE}, "two.json": {"source": f"https://github.com/{PRIVATE}"},
                    "three.json": {"repo": "example-private/other-thing"}})
        output = self.guard("staged")
        self.assertIn("placeholder example-org/example-repo-1", output)
        self.assertEqual(self.staged_json("one.json"), {"repo": "example-org/example-repo-1"})
        self.assertTrue(self.staged("one.json").startswith('{\n  "repo"'))
        self.assertEqual(self.staged_json("two.json"), {"source": "https://github.com/example-org/example-repo-1"})
        self.assertEqual(self.staged_json("three.json"), {"repo": "example-org/example-repo-2"})
        self.git("commit", "-m", "first")
        self.stage({"four.json": {"first": "example-private/other-thing", "repo": PRIVATE.upper()}})
        self.guard("staged")
        self.assertEqual(self.staged_json("four.json"),
                         {"first": "example-org/example-repo-2", "repo": "example-org/example-repo-1"})

    def test_pr_numbers_and_shas_are_remapped_consistently(self):
        self.stage({
            "a.json": {"repo": PRIVATE, "pr": 41, "head": SHA, "url": f"https://github.com/{PRIVATE}/pull/41",
                       "commit": f"https://github.com/{PRIVATE}/commit/{SHA}", "id": 41},
            "b.json": {"ref": f"{PRIVATE}#41", "short": SHA[:7], "pullRequests": [42, 41]},
        })
        self.guard("staged")
        a, b = self.staged_json("a.json"), self.staged_json("b.json")
        mapped = a["head"]
        self.assertNotEqual(mapped, SHA)
        self.assertRegex(mapped, r"^[0-9a-f]{40}$")
        self.assertEqual(a["pr"], 1)
        self.assertEqual(a["id"], 41)
        self.assertEqual(a["url"], "https://github.com/example-org/example-repo-1/pull/1")
        self.assertEqual(a["commit"], f"https://github.com/example-org/example-repo-1/commit/{mapped}")
        self.assertEqual(b["ref"], "example-org/example-repo-1#1")
        self.assertEqual(b["short"], mapped[:7])
        self.assertEqual(b["pullRequests"], [2, 1])

    def test_free_text_is_stubbed_while_kept_lines_survive(self):
        (self.repo / ".github").mkdir()
        (self.repo / ".github/publication-guard.json").write_text(json.dumps({"keep": ["^Ticket:"]}))
        text = ("**Status:** merged\nThe launch plan for the partner stays confidential\n"
                "Ticket: rollout\nBuild: passed\nDuration 12 ms\n\nAnother private sentence here")
        self.stage({"a.json": {"about": f"Recorded from {PRIVATE}.", "variants": [{"text": text, "title": "Short"}]},
                    "b.json": {"text": "A long sentence unrelated to any private repository at all"}})
        output = self.guard("staged")
        variant = self.staged_json("a.json")["variants"][0]
        self.assertEqual(variant["text"], "**Status:** merged\n[redacted]\nTicket: rollout\nBuild: passed\n"
                                          "Duration 12 ms\n\n[redacted]")
        self.assertEqual(variant["title"], "Short")
        self.assertEqual(self.staged_json("a.json")["about"], "[redacted]")
        self.assertEqual(self.staged_json("b.json")["text"], "A long sentence unrelated to any private repository at all")
        self.assertIn("stubbed lines 3", output)

    def test_prose_references_are_neutralised(self):
        self.stage({"notes.md": textwrap.dedent(f"""\
            Ported from {PRIVATE}.
            Fixes {PRIVATE}#12 and see https://github.com/{PRIVATE}/pull/3.
            Bug: https://github.com/{PRIVATE}/issues/9, commit https://github.com/{PRIVATE}/commit/{SHA}
            Read [the thread](https://github.com/{PRIVATE}/pull/3#discussion_r1) and `{PRIVATE}`.
            Keep {PUBLIC}#1.
            """)})
        self.guard("staged")
        self.assertEqual(self.staged("notes.md"), textwrap.dedent(f"""\
            Ported from a private repository.
            Fixes an issue or pull request in a private repository and see a pull request in a private repository.
            Bug: an issue in a private repository, commit a commit in a private repository
            Read a pull request in a private repository and `a private repository`.
            Keep {PUBLIC}#1.
            """))
        self.assertEqual((self.repo / "notes.md").read_text(), self.staged("notes.md"))

    def test_unresolvable_reference_counts_as_private(self):
        self.stage({"notes.md": f"From https://github.com/{GONE}/pull/9 and example-flaky/tool, "
                                "plus example-private/deleted-repo.\n"})
        self.guard("staged")
        self.assertEqual(self.staged("notes.md"), "From a pull request in a private repository and a private "
                                                  "repository, plus a private repository.\n")

    def test_word_pairs_and_paths_are_not_references(self):
        (self.repo / "docs").mkdir()
        (self.repo / "docs/guide.md").write_text("guide\n")
        (self.repo / "example-private").mkdir()
        (self.repo / "example-private/notes.md").write_text("notes\n")
        text = "Use and/or input/output, 09/30, docs/guide.md, example-private/notes.md, ./src/app and @scope/pkg.\n"
        self.stage({"notes.md": text})
        self.assertIn("nothing to rewrite", self.guard("staged"))
        self.assertEqual(self.staged("notes.md"), text)
        lookups = self.log.read_text()
        self.assertIn("repos/and/or", lookups)
        self.assertNotIn("repos/09/30", lookups)
        self.assertNotIn("repos/docs/guide.md", lookups)

    def test_commit_message_is_rewritten_before_the_commit_is_made(self):
        self.stage({"a.json": {"repo": PRIVATE}})
        message = self.write("message", f"fix: port retry from {PRIVATE}#7\n\nSee https://github.com/{PRIVATE}/pull/7\n")
        output = self.guard("staged", "--message-file", str(message))
        self.assertIn("rewrote commit message", output)
        self.git("commit", "-F", str(message))
        self.assertEqual(self.git("log", "-1", "--format=%B").strip(),
                         "fix: port retry from an issue or pull request in a private repository\n\n"
                         "See a pull request in a private repository")
        self.assertEqual(json.loads(self.git("show", "HEAD:a.json")), {"repo": "example-org/example-repo-1"})

    def test_pr_title_and_body_are_rewritten(self):
        title = self.write("title", f"feat: match {PRIVATE} retries")
        body = self.write("body", f"Mirrors https://github.com/{PRIVATE}/pull/5.\n\nCloses #3\n")
        output = self.guard("pr", "--title-file", str(title), "--body-file", str(body))
        self.assertIn("rewrote PR title", output)
        self.assertIn("rewrote PR body", output)
        self.assertEqual(title.read_text(), "feat: match a private repository retries")
        self.assertEqual(body.read_text(), "Mirrors a pull request in a private repository.\n\nCloses #3\n")

    def test_outgoing_diff_is_rewritten_and_staged(self):
        self.stage({"notes.md": f"Copied from {PRIVATE}.\n"})
        self.git("commit", "-m", "unguarded")
        self.guard("outgoing", "--base", "HEAD~1")
        self.assertEqual(self.staged("notes.md"), "Copied from a private repository.\n")
        self.assertEqual((self.repo / "notes.md").read_text(), "Copied from a private repository.\n")

    def test_second_run_changes_nothing_more(self):
        self.stage({"a.json": {"about": f"From {PRIVATE} with a long free-text sentence", "pr": 8, "head": SHA,
                               "url": f"https://github.com/{PRIVATE}/pull/8", "log": f"{SESSION}/run.log"},
                    "notes.md": f"See {PRIVATE}#8 and {self.repo}/notes.md in /Users/{USER}.\n"})
        message = self.write("message", f"fix: sync {PRIVATE} from {HOME}/notes.md\n")
        body = self.write("body", f"See https://github.com/{PRIVATE}/pull/8\n")
        self.guard("staged", "--message-file", str(message))
        self.guard("pr", "--body-file", str(body))
        first = (self.staged("a.json"), self.staged("notes.md"), message.read_text(), body.read_text())
        self.assertIn("nothing to rewrite", self.guard("staged", "--message-file", str(message)))
        self.assertIn("nothing to rewrite", self.guard("pr", "--body-file", str(body)))
        self.assertEqual((self.staged("a.json"), self.staged("notes.md"), message.read_text(), body.read_text()), first)

    def test_home_directory_and_username_become_a_tilde(self):
        self.stage({"notes.md": textwrap.dedent(f"""\
            Config at {HOME}/.config/example-tool.toml.
            Notes in /Users/{USER}/Documents/notes.md, /home/{USER}/src/app.py and C:\\Users\\{USER}\\AppData\\log.txt.
            Session log: {HOME}/.claude/projects/-srv-example-home-work-example-project/log.jsonl
            Untouched: /Users/{USER}name/a, /home/user/b and ~/c.
            """)})
        self.assertIn("local paths 6", self.guard("staged"))
        self.assertEqual(self.staged("notes.md"), textwrap.dedent("""\
            Config at ~/.config/example-tool.toml.
            Notes in ~/Documents/notes.md, ~/src/app.py and ~\\AppData\\log.txt.
            Session log: ~/.claude/projects/example-project/log.jsonl
            Untouched: /Users/example-username/a, /home/user/b and ~/c.
            """))

    def test_temporary_folders_become_tmp(self):
        self.stage({"notes.md": textwrap.dedent(f"""\
            Answer cites [create-pr/SKILL.md]({SESSION}/scratchpad/create-pr/SKILL.md).
            Also {AGENT_TMP}/build/out.txt, {MAC_TMP}/report.txt, /private{MAC_TMP}/x.txt,
            /var/example-tmp/T/cache/a.bin and {TMPDIR}/b.bin.
            Untouched: /tmp/scratch.txt, /tmp/claude-notes.txt and /private/tmp/run.log.
            """)})
        self.guard("staged")
        self.assertEqual(self.staged("notes.md"), textwrap.dedent("""\
            Answer cites [create-pr/SKILL.md](/tmp/example-project/0b6f5a2e-1c3d-4e5f-8a9b-0c1d2e3f4a5b/scratchpad/create-pr/SKILL.md).
            Also /tmp/build/out.txt, /tmp/report.txt, /tmp/x.txt,
            /tmp/cache/a.bin and /tmp/b.bin.
            Untouched: /tmp/scratch.txt, /tmp/claude-notes.txt and /private/tmp/run.log.
            """))

    def test_checkout_and_worktree_paths_become_relative_in_json(self):
        worktree = self.base / "example-worktree"
        self.git("worktree", "add", "-b", "example-branch", str(worktree))
        alias = str(self.repo).removeprefix("/private")  # macOS also spells /private/var as /var.
        self.stage({"evals/answers.json": {
            "answers": [{"text": f"Edited [SKILL.md]({self.repo}/create-pr/SKILL.md) and {worktree}/evals/a.json",
                         "cwd": str(self.repo), "guide": f"{alias}/docs/guide.md"}],
            "windows": f"C:\\Users\\{USER}\\notes.txt"}})
        self.guard("staged")
        expected = {"answers": [{"text": "Edited [SKILL.md](./create-pr/SKILL.md) and ./evals/a.json",
                                 "cwd": "./", "guide": "./docs/guide.md"}], "windows": "~\\notes.txt"}
        self.assertEqual(self.staged("evals/answers.json"), json.dumps(expected, indent=2) + "\n")

    def test_main_checkout_outside_home_and_temporary_folders_stays_literal(self):
        container = publication_guard.LocalPaths("/srv/example-app", ["/srv/example-app/.claude/worktrees/example-worktree"],
                                                 [], [f"/home/{USER}"], USER)
        self.assertEqual(container.rewrite("WORKDIR /srv/example-app\n/srv/example-app/.claude/worktrees/example-worktree/a.md"),
                         ("WORKDIR /srv/example-app\n./a.md", 1))
        personal = publication_guard.LocalPaths(f"/home/{USER}/src/example-app", [], [], [f"/home/{USER}"], USER)
        self.assertEqual(personal.rewrite(f"/home/{USER}/src/example-app/a.md and /home/{USER}/b"), ("./a.md and ~/b", 2))
        scratch = publication_guard.LocalPaths("/var/tmp/example-app")
        self.assertEqual(scratch.rewrite("/var/tmp/example-app/a.md"), ("./a.md", 1))

    def test_windows_home_and_resolved_spellings_are_recognised(self):
        windows = publication_guard.LocalPaths(homes=[f"C:\\Users\\{USER}"])
        self.assertEqual(windows.rewrite(f"C:/Users/{USER}/a and c:\\users\\{USER}\\b"), ("~/a and ~\\b", 2))
        target = self.base / "session-target"
        target.mkdir()
        (self.base / "session-link").symlink_to(target)
        linked = publication_guard.LocalPaths(temp_dirs=[str(self.base / "session-link")])
        self.assertEqual(linked.rewrite(f"{target}/log.txt"), ("/tmp/log.txt", 1))
        self.assertEqual(publication_guard.LocalPaths(temp_dirs=["/tmp"]).rewrite("/tmp/log.txt"), ("/tmp/log.txt", 0))

    def test_local_paths_leave_commit_messages_and_pr_metadata(self):
        message = self.write("message", f"fix: read /Users/{USER}/notes.txt\n")
        self.assertIn("rewrote commit message: local paths 1", self.guard("staged", "--message-file", str(message)))
        self.assertEqual(message.read_text(), "fix: read ~/notes.txt\n")
        title = self.write("title", f"docs: logs in {SESSION}")
        body = self.write("body", f"Logs: {SESSION}/out.txt\n")
        self.guard("pr", "--title-file", str(title), "--body-file", str(body))
        self.assertEqual(title.read_text(), "docs: logs in /tmp/example-project/0b6f5a2e-1c3d-4e5f-8a9b-0c1d2e3f4a5b")
        self.assertEqual(body.read_text(), "Logs: /tmp/example-project/0b6f5a2e-1c3d-4e5f-8a9b-0c1d2e3f4a5b/out.txt\n")

    def test_outgoing_names_commits_that_already_hold_the_original_text(self):
        self.stage({"notes.md": f"Read /Users/{USER}/notes.txt\n", "ported.md": f"Ported from {PRIVATE}.\n"})
        self.git("commit", "-m", "docs: add notes")
        leaked = self.git("rev-parse", "--short=7", "HEAD").strip()
        self.stage({"notes.md": "Read the notes\n"})
        self.git("rm", "-q", "ported.md")
        self.git("commit", "-m", "docs: drop the path")
        clean = self.git("rev-parse", "--short=7", "HEAD").strip()
        self.stage({"other.md": f"Ported from /home/{USER}/src.\n"})
        self.git("commit", "-m", f"docs: port from https://github.com/{GONE}/pull/2")
        both = self.git("rev-parse", "--short=7", "HEAD").strip()
        output = self.guard("outgoing", "--base", "HEAD~3")
        self.assertIn(f"commit {leaked} adds a private reference or local path to notes.md, ported.md; "
                      "pushing publishes that commit unchanged", output)
        self.assertIn(f"commit {both} adds a private reference or local path to other.md, its message", output)
        self.assertNotIn(clean, output)
        self.assertNotIn("earlier commits on the branch", output)
        self.assertEqual(self.staged("notes.md"), "Read the notes\n")
        self.assertEqual(self.staged("other.md"), "Ported from ~/src.\n")

    def test_unknown_destination_is_an_operational_error(self):
        result = subprocess.run([sys.executable, str(HELPER), "pr", "--repo", "example-gone/nowhere"],
                                cwd=self.repo, capture_output=True, text=True, env=self.guard_env)
        self.assertEqual(result.returncode, 2)
        self.assertIn("cannot ask GitHub", result.stderr)


if __name__ == "__main__":
    unittest.main()
