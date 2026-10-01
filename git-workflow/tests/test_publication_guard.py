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
                                capture_output=True, text=True, env=self.env)
        self.assertEqual(result.returncode, 0, result.stderr)
        if repo == PUBLIC:
            self.assertNotIn("secret-repo", result.stdout)
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
        self.stage({"a.json": {"repo": PRIVATE, "pr": 4, "from": other}, "notes.md": f"See {PRIVATE}#4 and {other}.\n"})
        message = self.write("message", f"fix: sync {PRIVATE} from {other}\n")
        output = self.guard("staged", "--message-file", str(message), repo=PRIVATE)
        self.assertIn("not public", output)
        self.assertEqual(self.staged_json("a.json"), {"repo": PRIVATE, "pr": 4, "from": other})
        self.assertEqual(self.staged("notes.md"), f"See {PRIVATE}#4 and {other}.\n")
        self.assertEqual(message.read_text(), f"fix: sync {PRIVATE} from {other}\n")
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
        self.assertIn("lines stubbed", output)

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
                               "url": f"https://github.com/{PRIVATE}/pull/8"},
                    "notes.md": f"See {PRIVATE}#8.\n"})
        message = self.write("message", f"fix: sync {PRIVATE}\n")
        body = self.write("body", f"See https://github.com/{PRIVATE}/pull/8\n")
        self.guard("staged", "--message-file", str(message))
        self.guard("pr", "--body-file", str(body))
        first = (self.staged("a.json"), self.staged("notes.md"), message.read_text(), body.read_text())
        self.assertIn("nothing to rewrite", self.guard("staged", "--message-file", str(message)))
        self.assertIn("nothing to rewrite", self.guard("pr", "--body-file", str(body)))
        self.assertEqual((self.staged("a.json"), self.staged("notes.md"), message.read_text(), body.read_text()), first)

    def test_unknown_destination_is_an_operational_error(self):
        result = subprocess.run([sys.executable, str(HELPER), "pr", "--repo", "example-gone/nowhere"],
                                cwd=self.repo, capture_output=True, text=True, env=self.env)
        self.assertEqual(result.returncode, 2)
        self.assertIn("cannot ask GitHub", result.stderr)


if __name__ == "__main__":
    unittest.main()
