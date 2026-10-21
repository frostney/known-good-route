import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).parents[1] / "scripts" / "check_template.py"
sys.path.insert(0, str(SCRIPT_PATH.parent))  # The script imports check_prose beside it.
SPEC = importlib.util.spec_from_file_location("check_template", SCRIPT_PATH)
assert SPEC and SPEC.loader
CHECK_TEMPLATE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = CHECK_TEMPLATE  # dataclasses resolve their module by name.
SPEC.loader.exec_module(CHECK_TEMPLATE)


ISSUE_TEMPLATE = """---
name: Issue
about: Propose a feature, fix, or scoped change
title: ""
---

## Summary

What should change?

## Why

Why is this needed?

## Current behavior

What happens today?

## Expected behavior

What should happen instead?

## Scope notes

Constraints, non-goals, related issues, or implementation notes.
"""

BUG_FORM = """name: Bug report
description: Something is broken
body:
  - type: markdown
    attributes:
      value: |
        ## Thanks for reporting
  - type: input
    id: version
    attributes:
      label: Version
      placeholder: "1.2.3"
    validations:
      required: true
  - type: textarea
    attributes:
      label: "Steps to reproduce"
  - type: checkboxes
    attributes:
      label: Checks
      options:
        - label: I searched existing issues
"""

# Fake gh: answers each argument list from the scenario file; anything else is
# a missing resource, which gh reports as HTTP 404.
FAKE_GH = r"""#!/usr/bin/env python3
import json, os, pathlib, sys

responses = json.loads(pathlib.Path(os.environ["FAKE_GH_SCENARIO"]).read_text())
answer = responses.get(" ".join(sys.argv[1:]))
if answer is None:
    print("gh: Not Found (HTTP 404)", file=sys.stderr)
    sys.exit(1)
print(answer, end="")
"""


def body(*sections):
    return "\n\n".join(f"{heading}\n\n{text}" if text else heading for heading, text in sections) + "\n"


FULL = [
    ("## Summary", "Add the flag."),
    ("## Why", "Users asked."),
    ("## Current behavior", "No flag."),
    ("## Expected behavior", "A flag."),
    ("## Scope notes", "None."),
]


class HeadingTests(unittest.TestCase):
    def test_reads_atx_headings_outside_code_comments_and_quotes(self):
        found = CHECK_TEMPLATE.headings(
            "\r\n".join([
                "# Title #",
                "##   Spaced   words  ",
                "## C#",
                "#hashtag is not a heading",
                "> ## Quoted",
                "<!-- ## Commented -->",
                "<!--",
                "## Inside a multi-line comment",
                "-->",
                "```markdown",
                "## In a code block",
                "```",
                "~~~",
                "## In a tilde block",
                "~~~",
                "    ### Indented code is not a heading either",
                "### Last",
            ])
        )

        self.assertEqual(
            [str(heading) for heading in found],
            ["# Title", "## Spaced words", "## C#", "### Last"],
        )

    def test_section_content_runs_to_the_next_heading_at_the_same_or_higher_level(self):
        found = CHECK_TEMPLATE.headings(
            "\n".join([
                "## Only a comment",
                "<!-- Describe the change. -->",
                "## Has a subsection",
                "### Sub",
                "Text.",
                "## Code only",
                "```text",
                "output",
                "```",
                "## Last and empty",
                "",
            ])
        )

        self.assertEqual(
            [(heading.text, heading.has_content) for heading in found],
            [
                ("Only a comment", False),
                ("Has a subsection", True),
                ("Sub", True),
                ("Code only", True),
                ("Last and empty", False),
            ],
        )

    def test_issue_form_fields_become_level_three_headings(self):
        template = CHECK_TEMPLATE.parse_template("bug.yml", BUG_FORM)

        self.assertEqual(template.name, "Bug report")
        self.assertEqual(
            [str(heading) for heading in template.headings],
            ["### Version", "### Steps to reproduce", "### Checks"],
        )

    def test_unclosed_comment_inside_a_line_is_literal_text(self):
        found = CHECK_TEMPLATE.headings("## A\nUse `<!--` to open a comment.\n## B\nText.\n")

        self.assertEqual([str(heading) for heading in found], ["## A", "## B"])

    def test_issue_form_layouts_and_label_styles(self):
        template = CHECK_TEMPLATE.parse_template(
            "bug.yaml",
            "\n".join([
                "name: 'It''s a form'",
                "body:",
                "- type: input",
                "  attributes:",
                "    label: \"Version: \\\"exact\\\"\" # quoted, with a comment",
                "- type: textarea",
                "  attributes:",
                "    label: >-",
                "      Steps to",
                "      reproduce",
                "    description: Folded label above",
                "- type: textarea",
                "  attributes:",
                "    label: Logs # plain, with a comment",
                "- type: textarea",
                "  attributes:",
                "    label: |2-",
                "      # Hash",
                "      line",
                "# A comment between fields",
                "- type: input",
                "  attributes:",
                "    label: After the comment",
            ]),
        )

        self.assertEqual(template.name, "It's a form")
        self.assertEqual(
            [str(heading) for heading in template.headings],
            ['### Version: "exact"', "### Steps to reproduce", "### Logs", "### # Hash line", "### After the comment"],
        )

    def test_issue_form_whose_labels_cannot_be_read_is_an_error(self):
        with self.assertRaises(CHECK_TEMPLATE.CheckError):
            CHECK_TEMPLATE.parse_template(
                "flow.yml", "body: [{type: input, attributes: {label: Version}}]\n"
            )

    def test_byte_order_mark_does_not_hide_the_first_heading(self):
        template = CHECK_TEMPLATE.parse_template("bom.md", "\ufeff## Summary\n")

        self.assertEqual([str(heading) for heading in template.headings], ["## Summary"])

    def test_markdown_template_front_matter_names_it(self):
        template = CHECK_TEMPLATE.parse_template("default.md", ISSUE_TEMPLATE)

        self.assertEqual(template.name, "Issue")
        self.assertEqual(len(template.headings), 5)


class CompareTests(unittest.TestCase):
    def compare(self, sections):
        template = CHECK_TEMPLATE.parse_template("default.md", ISSUE_TEMPLATE)
        return [
            (problem["kind"], problem["expected"], problem["actual"])
            for problem in CHECK_TEMPLATE.compare(
                template.headings, CHECK_TEMPLATE.headings(body(*sections))
            )
        ]

    def test_matching_body_with_extra_subsections_has_no_problems(self):
        sections = [*FULL[:2], ("### Detail", "More."), *FULL[2:]]

        self.assertEqual(self.compare(sections), [])

    def test_dropped_and_prose_only_bodies_report_missing_headings(self):
        self.assertEqual(
            self.compare([FULL[0], FULL[1], FULL[3]]),
            [
                ("missing", "## Current behavior", None),
                ("missing", "## Scope notes", None),
            ],
        )
        self.assertEqual(
            [kind for kind, _, _ in self.compare([("Plain prose.", "")])],
            ["missing"] * 5,
        )

    def test_renamed_headings_pair_with_their_closest_wording(self):
        # Seen in practice: "Expected" and "Notes" replaced two later headings,
        # and two earlier ones were dropped.
        self.assertEqual(
            self.compare([FULL[0], ("## Expected", "A flag."), ("## Notes", "None.")]),
            [
                ("missing", "## Why", None),
                ("missing", "## Current behavior", None),
                ("renamed", "## Expected behavior", "## Expected"),
                ("renamed", "## Scope notes", "## Notes"),
            ],
        )

    def test_case_level_and_wholesale_renames_are_renames(self):
        self.assertEqual(
            self.compare([
                ("## summary", "Add the flag."),
                ("### Why", "Users asked."),
                ("## Motivation and context", "No flag."),
                *FULL[3:],
            ]),
            [
                ("renamed", "## Summary", "## summary"),
                ("renamed", "## Why", "### Why"),
                ("renamed", "## Current behavior", "## Motivation and context"),
            ],
        )

    def test_moved_heading_is_out_of_order(self):
        self.assertEqual(
            self.compare([FULL[0], FULL[2], FULL[1], *FULL[3:]]),
            [("out-of-order", "## Why", "## Why")],
        )

    def test_heading_with_nothing_under_it_is_empty(self):
        self.assertEqual(
            self.compare([*FULL[:4], ("## Scope notes", "<!-- nothing -->")]),
            [("empty", "## Scope notes", "## Scope notes")],
        )


class SelectTests(unittest.TestCase):
    def test_body_missing_a_heading_still_selects_the_template_it_follows(self):
        smaller = CHECK_TEMPLATE.parse_template("small.md", "## Summary\n\n## Testing\n")
        larger = CHECK_TEMPLATE.parse_template("large.md", "## Summary\n\n## Why\n\n## Testing\n\n## Notes\n")
        found = CHECK_TEMPLATE.headings(body(("## Summary", "A."), ("## Why", "B."), ("## Testing", "C.")))

        template, problems = CHECK_TEMPLATE.select([smaller, larger], found, None)

        self.assertEqual(template.path, "large.md")
        self.assertEqual([(problem["kind"], problem["expected"]) for problem in problems], [("missing", "## Notes")])


class CommandTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.scenario = self.root / "gh.json"
        self.scenario.write_text("{}", encoding="utf-8")
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        gh = bin_dir / "gh"
        gh.write_text(FAKE_GH, encoding="utf-8")
        gh.chmod(gh.stat().st_mode | stat.S_IEXEC)
        self.env = {
            **os.environ,
            "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
            "FAKE_GH_SCENARIO": str(self.scenario),
            # Keep git from finding a checkout above a temporary directory.
            "GIT_CEILING_DIRECTORIES": str(self.root.parent),
        }
        self.checkout = self.root / "checkout"
        self.checkout.mkdir()

    def tearDown(self):
        self.directory.cleanup()

    def write(self, relative, text):
        path = self.checkout / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def run_check(self, *args, stdin=None):
        result = subprocess.run(
            [sys.executable, str(SCRIPT_PATH), *args, "--json"],
            cwd=self.root,
            env=self.env,
            input=stdin,
            capture_output=True,
            text=True,
            timeout=60,
        )
        return result.returncode, json.loads(result.stdout)

    def test_exit_status_follows_the_comparison(self):
        template = self.write("template.md", ISSUE_TEMPLATE)
        matching = self.write("matching.md", body(*FULL))

        code, result = self.run_check("--template", str(template), "--body", str(matching))
        self.assertEqual((code, result["state"]), (0, "match"))

        code, result = self.run_check("--template", str(template), "--body", "-", stdin="Prose only.\n")
        self.assertEqual((code, result["state"], len(result["problems"])), (1, "mismatch", 5))

        code, result = self.run_check("--template", str(self.checkout / "absent.md"), "--body", str(matching))
        self.assertEqual((code, result["state"]), (2, "operational-error"))

    def test_discovery_picks_among_several_issue_templates(self):
        self.write(".github/ISSUE_TEMPLATE/default.md", ISSUE_TEMPLATE)
        self.write(".github/ISSUE_TEMPLATE/bug.yml", BUG_FORM)
        self.write(".github/ISSUE_TEMPLATE/config.yml", "blank_issues_enabled: false\n")
        form_body = body(("### Version", "1.2.3"), ("### Steps to reproduce", "Run it."), ("### Checks", "- [x] Searched"))
        common = ("--root", str(self.checkout), "--kind", "issue", "--body", "-")

        code, result = self.run_check(*common, stdin=form_body)
        self.assertEqual((code, result["template"]["name"]), (0, "Bug report"))

        code, result = self.run_check(*common, "--template-name", "Issue", stdin=form_body)
        self.assertEqual((code, result["template"]["name"], len(result["problems"])), (1, "Issue", 5))

        code, result = self.run_check(*common, "--template-name", "absent", stdin=form_body)
        self.assertEqual((code, result["state"]), (2, "operational-error"))

    def test_checkout_without_a_template_has_nothing_to_compare(self):
        code, result = self.run_check("--root", str(self.checkout), "--kind", "pr", "--body", "-", stdin="Prose.\n")
        self.assertEqual((code, result["state"]), (0, "no-template"))

        prose = self.write("prose.md", "A template without headings.\n")
        code, result = self.run_check("--template", str(prose), "--body", "-", stdin="Prose.\n")
        self.assertEqual((code, result["state"]), (0, "no-template"))

    def test_a_check_that_cannot_run_is_an_operational_error(self):
        undecodable = self.root / "latin1.md"
        undecodable.write_bytes("## Caf\xe9\n".encode("latin-1"))
        template = self.write("template.md", ISSUE_TEMPLATE)
        for name, args in (
            ("undecodable body", ("--template", str(template), "--body", str(undecodable))),
            ("outside a git checkout", ("--kind", "pr", "--body", "-")),
            ("unreachable repository", ("--repo", "owner/absent", "--kind", "pr", "--body", "-")),
        ):
            with self.subTest(name):
                code, result = self.run_check(*args, stdin="## Summary\n")
                self.assertEqual((code, result["state"]), (2, "operational-error"))

    def test_live_pull_request_body_against_its_repository_template(self):
        repo = "owner/project"
        listing = lambda *names: json.dumps([{"name": name, "type": kind} for name, kind in names])
        self.scenario.write_text(json.dumps({
            f"pr view 7 --json body --repo {repo}": json.dumps({"body": "## Summary\r\n\r\nDone.\r\n"}),
            f"api repos/{repo}/contents": listing(("README.md", "file"), (".github", "dir")),
            f"api repos/{repo}/contents/.github": listing(("PULL_REQUEST_TEMPLATE.md", "file")),
            f"api -H Accept: application/vnd.github.raw repos/{repo}/contents/.github/PULL_REQUEST_TEMPLATE.md":
                "## Summary\n\n## Testing\n",
        }), encoding="utf-8")

        code, result = self.run_check("--pr", "7", "--repo", repo)

        self.assertEqual(code, 1)
        self.assertEqual(result["template"]["path"], ".github/PULL_REQUEST_TEMPLATE.md")
        self.assertEqual(
            [(problem["kind"], problem["expected"]) for problem in result["problems"]],
            [("missing", "## Testing")],
        )


if __name__ == "__main__":
    unittest.main()
