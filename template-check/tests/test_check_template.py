import html
import importlib.util
import inspect
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


sys.dont_write_bytecode = True  # Loading the script below must not cache it in the skill tree.

SCRIPT_PATH = Path(__file__).parents[1] / "scripts" / "check_template.py"
SPEC = importlib.util.spec_from_file_location("check_template", SCRIPT_PATH)
assert SPEC and SPEC.loader
CHECK_TEMPLATE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = CHECK_TEMPLATE  # dataclasses resolve their module by name.
SPEC.loader.exec_module(CHECK_TEMPLATE)


def mini_render(text):
    """Enough of GitHub's rendering for these tests' plain bodies.

    Parsing tests use HTML GitHub rendered, from github_rendered.json.
    """
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    out = []
    for line in text.split("\n"):
        line = line.strip()
        heading = re.fullmatch(r"(#{1,6})\s+(.*)", line)
        item = re.fullmatch(r"(?:[-*+]|[0-9]+[.)])(?:\s+(.*))?", line)
        if not line:
            continue
        if re.fullmatch(r"-{3,}", line):
            out.append("<hr>")
        elif heading:
            level = len(heading.group(1))
            out.append(f"<h{level}>{html.escape(heading.group(2))}</h{level}>")
        elif item:
            out.append(f"<ul><li>{html.escape(item.group(1) or '')}</li></ul>")
        else:
            out.append(f"<p>{html.escape(line)}</p>")
    return "\n".join(out)


# The fake gh renders Markdown with the same stand-in.
MINI_RENDER = "import html, re\n\n" + inspect.getsource(mini_render)
# Unit tests never call GitHub: Markdown templates render through the stand-in.
REAL_RENDER = CHECK_TEMPLATE.render
CHECK_TEMPLATE.render = mini_render
RENDERED = json.loads((Path(__file__).parent / "github_rendered.json").read_text(encoding="utf-8"))


def md_headings(text, kind=None):
    return CHECK_TEMPLATE.headings(mini_render(text), kind)


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
""" + MINI_RENDER + r"""
responses = json.loads(pathlib.Path(os.environ["FAKE_GH_SCENARIO"]).read_text())
if sys.argv[1:2] == ["api"] and sys.argv[-3:] == ["markdown", "--input", "-"]:
    text = json.load(sys.stdin)["text"]
    if "render-error" in responses or responses.get("render-error-for", "\0") in text:
        print(responses.get("render-error", "gh: Server Error (HTTP 500)"), file=sys.stderr)
        sys.exit(1)
    print(mini_render(text), end="")
    sys.exit(0)
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


class RenderedHeadingTests(unittest.TestCase):
    """Headings read from HTML that GitHub's Markdown API rendered for each case."""

    def read(self, case, kind=None):
        return [(heading.text, heading.has_content) for heading in CHECK_TEMPLATE.headings(RENDERED[case]["html"], kind)]

    def test_a_placeholder_list_item_is_not_content(self):
        self.assertEqual(
            self.read("placeholders"), [("Summary", False), ("Steps", False), ("Tasks", False), ("Filled", True)]
        )

    def test_headings_in_code_comments_quotes_lists_and_tables_are_content(self):
        self.assertEqual(self.read("code_comment_quote"), [("A", True), ("B", True)])

    def test_a_fence_inside_a_list_item_keeps_its_heading_as_code(self):
        self.assertEqual(self.read("list_fence"), [("Summary", True)])

    def test_a_section_runs_to_the_next_heading_at_the_same_or_higher_level(self):
        self.assertEqual(
            self.read("sections"),
            [("Title", True), ("Summary", True), ("Detail", True), ("Empty", False), ("Media", True)],
        )

    def test_a_pull_requests_review_note_is_not_content(self):
        self.assertEqual(self.read("review_note", "pr"), [("Summary", True), ("Testing", False)])
        self.assertEqual(
            self.read("review_note", "issue"), [("Summary", True), ("Testing", True), ("After the note", False)]
        )
        self.assertEqual(self.read("rule_only", "pr"), [("Testing", True)])

    def test_only_the_generated_attribution_note_is_dropped_from_an_issue(self):
        self.assertEqual(self.read("attribution", "issue"), [("Related", False)])
        self.assertEqual(self.read("attribution", "pr"), [("Related", True)])
        self.assertEqual(self.read("note_by_person", "issue"), [("Related", True)])

    def test_a_heading_inside_an_alert_is_content(self):
        self.assertEqual(self.read("alert_heading"), [("A", True), ("B", True)])

    def test_a_heading_inside_details_is_a_section(self):
        self.assertEqual(self.read("details"), [("Summary", True), ("Inside details", True)])

    def test_text_after_a_comment_on_its_line_is_no_heading(self):
        self.assertEqual(self.read("comment_line_heading"), [("Summary", True)])

    def test_a_setext_heading_is_a_heading_as_github_shows_it(self):
        self.assertEqual(self.read("setext"), [("A topic", True)])

    def test_the_footnotes_github_appends_are_no_section(self):
        self.assertEqual(self.read("footnotes"), [("Summary", True)])

    def test_a_checked_task_item_is_content_and_an_unchecked_one_is_not(self):
        self.assertEqual(self.read("checked_task"), [("Done", True), ("Open", False)])

    def test_the_review_note_cut_falls_at_the_rule_before_it(self):
        self.assertEqual(self.read("two_rules", "pr"), [("Summary", True), ("Testing", True)])

    def test_markdown_renders_on_the_target_host(self):
        calls = []
        original = CHECK_TEMPLATE.gh_runner
        CHECK_TEMPLATE.gh_runner = lambda args, stdin=None: calls.append(args) or "<h2>A</h2>"
        try:
            REAL_RENDER("## A", "ghe.example.com")
            REAL_RENDER("## A")
        finally:
            CHECK_TEMPLATE.gh_runner = original
        self.assertEqual(calls[0][:3], ["api", "--hostname", "ghe.example.com"])
        self.assertEqual(calls[1][:2], ["api", "markdown"])

    def test_the_target_host_follows_the_repository(self):
        environment = {key: os.environ.pop(key) for key in ("GH_REPO", "GH_HOST") if key in os.environ}
        try:
            self.assertEqual(CHECK_TEMPLATE.target_host("ghe.example.com/owner/repo", None), "ghe.example.com")
            os.environ["GH_HOST"] = "ghe.example.com"
            self.assertEqual(CHECK_TEMPLATE.target_host("a private repository", None), "ghe.example.com")
            del os.environ["GH_HOST"]
            self.assertIsNone(CHECK_TEMPLATE.target_host("a private repository", None))
        finally:
            os.environ.pop("GH_HOST", None)
            os.environ.update(environment)
        self.assertEqual(
            [
                CHECK_TEMPLATE.remote_host(url)
                for url in ("git@ghe.example.com:owner/repo.git", "a private repository", "ssh://git@ghe.example.com/owner/repo")
            ],
            ["ghe.example.com", "github.com", "ghe.example.com"],
        )


class TemplateParsingTests(unittest.TestCase):
    def test_form_labels_compare_as_github_renders_them(self):
        template = CHECK_TEMPLATE.parse_template(
            "f.yml",
            "body:\n  - type: input\n    attributes:\n      label: Run `--help`\n",
            lambda markdown: mini_render(markdown.replace("`", "")),
        )
        self.assertEqual([str(h) for h in template.headings], ["### Run --help"])

    def test_a_comment_after_a_type_key_leaves_it_to_continue_below(self):
        template = CHECK_TEMPLATE.parse_template(
            "f.yml",
            "body:\n  - type: # explanation\n      markdown\n    attributes:\n      value: hi\n"
            "  - type: input\n    attributes:\n      label: A\n",
        )
        self.assertEqual([str(h) for h in template.headings], ["### A"])

    def test_a_flow_key_needs_a_space_after_its_colon(self):
        with self.assertRaises(CHECK_TEMPLATE.CheckError):
            CHECK_TEMPLATE.parse_template("f.yml", "body:\n  - type: input\n    attributes: {label:Summary}\n")

    def test_a_field_written_as_a_flow_mapping_is_an_error(self):
        with self.assertRaises(CHECK_TEMPLATE.CheckError):
            CHECK_TEMPLATE.parse_template("f.yml", "body:\n  - {type: input,\n    attributes: {label: Summary}\n    }\n")

    def test_a_name_type_or_label_may_continue_below_its_key(self):
        template = CHECK_TEMPLATE.parse_template(
            "f.yml",
            "name:\n  bug-report\nbody:\n  - type:\n      markdown\n    attributes:\n      value: hi\n"
            "  - type: input\n    attributes:\n      label:\n        Steps\n",
        )
        self.assertEqual((template.name, [str(h) for h in template.headings]), ("bug-report", ["### Steps"]))

    def test_issue_form_reads_flow_attributes_and_rejects_an_unreadable_field(self):
        form = "\n".join([
            "body:",
            "  - type: textarea",
            "    attributes:",
            "      label: What happened",
            "  - type: textarea",
            "    attributes: {label: 'Steps to reproduce', description: How}",
        ])
        template = CHECK_TEMPLATE.parse_template("form.yml", form)
        self.assertEqual([str(h) for h in template.headings], ["### What happened", "### Steps to reproduce"])
        with self.assertRaisesRegex(CHECK_TEMPLATE.CheckError, "line 5"):
            CHECK_TEMPLATE.parse_template("form.yml", form.replace("{label: 'Steps to reproduce', description: How}", "[odd]"))

    def test_an_opening_rule_over_markdown_is_not_front_matter(self):
        template = CHECK_TEMPLATE.parse_template("pull_request_template.md", "---\n\n## Summary\n\n-\n\n---\n\nMore.\n")
        self.assertEqual([str(h) for h in template.headings], ["## Summary"])

    def test_flow_attributes_read_the_label_key_not_text_inside_another_value(self):
        template = CHECK_TEMPLATE.parse_template(
            "form.yml",
            'body:\n  - type: textarea\n    attributes: {description: "Choose a value, label: example", label: Steps}\n',
        )
        self.assertEqual([str(h) for h in template.headings], ["### Steps"])

    def test_flow_mapping_quotes_open_only_where_a_scalar_starts(self):
        self.assertEqual(
            [
                CHECK_TEMPLATE.flow_mapping(text)["label"]
                for text in (
                    "{label: What's wrong?, description: Details}",
                    "{label: 'It''s, ok', description: x}",
                    '{label: "a \\" b, c", description: x}',
                )
            ],
            ["What's wrong?", "It's, ok", 'a " b, c'],
        )

    def test_issue_form_keys_may_be_quoted_and_its_name_may_follow_the_body(self):
        form = 'body:\n  - "type": markdown\n    attributes:\n      value: hi\n  - type: input\n    attributes:\n      label: A\nname: Late\n'
        template = CHECK_TEMPLATE.parse_template("form.yml", form)
        self.assertEqual((template.name, [str(h) for h in template.headings]), ("Late", ["### A"]))
        with self.assertRaises(CHECK_TEMPLATE.CheckError) as raised:
            CHECK_TEMPLATE.parse_template("form.yml", form.replace("value: hi", "value: hi\n  - type: input\n    attributes: [odd]"))
        self.assertEqual(raised.exception.name, "Late")

    def test_front_matter_may_end_its_yaml_document_with_dots(self):
        self.assertEqual(CHECK_TEMPLATE.parse_template("x.md", "---\nname: Bug\n...\n---\n## A\n").name, "Bug")

    def test_brackets_and_commas_inside_a_nested_quoted_value_are_text(self):
        mapping = CHECK_TEMPLATE.flow_mapping('{options: ["] , label: Wrong, ]"], label: Correct}')
        self.assertEqual(mapping["label"], "Correct")

    def test_front_matter_may_close_a_flow_list_at_the_margin(self):
        self.assertEqual(CHECK_TEMPLATE.parse_template("x.md", "---\nname: Bug\nlabels: [\n  bug,\n]\n---\n## A\n").name, "Bug")

    def test_a_form_field_dash_may_stand_alone_above_its_mapping(self):
        form = "body:\n  -\n    type: textarea\n    attributes:\n      label: Summary\n  - type: input\n    attributes: {label: Steps}\n"
        self.assertEqual(
            [str(h) for h in CHECK_TEMPLATE.parse_template("form.yml", form).headings], ["### Summary", "### Steps"]
        )
        deeper = form.replace("    type: textarea\n    attributes:\n      label", "      type: textarea\n      attributes:\n        label")
        self.assertEqual(
            [str(h) for h in CHECK_TEMPLATE.parse_template("form.yml", deeper).headings], ["### Summary", "### Steps"]
        )

    def test_a_comment_may_follow_inline_form_attributes(self):
        template = CHECK_TEMPLATE.parse_template(
            "form.yml", "body:\n  - type: input\n    attributes: {label: 'C# guide'} # Required entry\n"
        )
        self.assertEqual([str(h) for h in template.headings], ["### C# guide"])

    def test_front_matter_may_put_a_sequence_dash_on_its_own_line(self):
        self.assertEqual(
            CHECK_TEMPLATE.parse_template("x.md", "---\nname: Bug Report\nlabels:\n-\n  bug\n---\n## A\n").name, "Bug Report"
        )

    def test_an_inline_mapping_that_does_not_close_is_an_error(self):
        with self.assertRaises(CHECK_TEMPLATE.CheckError):
            CHECK_TEMPLATE.parse_template(
                "form.yml", 'body:\n  - type: textarea\n    "attributes": {\n      label: Steps to\n      reproduce }\n'
            )

    def test_the_yaml_end_marker_may_carry_a_comment(self):
        self.assertEqual(CHECK_TEMPLATE.parse_template("x.md", "---\nname: Bug\n... # end\n---\n## A\n").name, "Bug")

    def test_inline_attributes_whose_outer_mapping_stays_open_are_an_error(self):
        with self.assertRaises(CHECK_TEMPLATE.CheckError):
            CHECK_TEMPLATE.parse_template(
                "form.yml",
                "body:\n  - type: checkboxes\n    attributes: {label: Terms, options: [{label: I agree}\n      ]}\n",
            )

    def test_front_matter_keys_may_contain_spaces(self):
        template = CHECK_TEMPLATE.parse_template("x.md", "---\nname: Bug Report\ncustom display: ignored\n---\n## A\n")
        self.assertEqual(template.name, "Bug Report")

    def test_a_folded_form_name_names_the_form_and_its_errors(self):
        with self.assertRaises(CHECK_TEMPLATE.CheckError) as raised:
            CHECK_TEMPLATE.parse_template("report.yml", "name: >-\n  Bug\nbody:\n  - type: input\n    attributes: [odd]\n")
        self.assertEqual(raised.exception.name, "Bug")

    def test_a_quote_after_a_colon_inside_a_plain_value_is_text(self):
        self.assertEqual(CHECK_TEMPLATE.flow_mapping("{label: Use ':' in code}"), {"label": "Use ':' in code"})

    def test_front_matter_with_a_wrapped_value_keeps_its_name(self):
        template = CHECK_TEMPLATE.parse_template("x.md", "---\nname: Bug Report\nabout: 'Tell us\nwhat broke'\n---\n## A\n")
        self.assertEqual(template.name, "Bug Report")

    def test_a_quoted_value_may_follow_a_quoted_key_with_no_space(self):
        self.assertEqual(CHECK_TEMPLATE.flow_mapping('{"label":"Steps, logs"}'), {"label": "Steps, logs"})

    def test_a_form_written_as_one_flow_mapping_keeps_its_name(self):
        self.assertEqual(
            CHECK_TEMPLATE.declared_name("{name: bug-report, body: [{type: input, attributes: {label: A}}]}\n"), "bug-report"
        )

    def test_a_field_key_column_follows_the_padding_after_its_dash(self):
        template = CHECK_TEMPLATE.parse_template("f.yml", "body:\n  -   type: input\n      attributes:\n        label: A\n")
        self.assertEqual([str(h) for h in template.headings], ["### A"])

    def test_yaml_escapes_in_a_double_quoted_label_decode(self):
        self.assertEqual(CHECK_TEMPLATE.flow_mapping('{label: "OS \\x28optional\\x29"}'), {"label": "OS (optional)"})

    def test_a_field_whose_dash_is_followed_by_a_tab_is_never_skipped(self):
        with self.assertRaises(CHECK_TEMPLATE.CheckError):
            CHECK_TEMPLATE.parse_template(
                "f.yml", "body:\n  - type: input\n    attributes: {label: A}\n  -\t{type: input, attributes: {label: B}}\n"
            )

    def test_a_comment_only_dash_takes_its_key_column_from_the_first_key(self):
        form = "body:\n  -  # instructions\n    type: markdown\n    attributes:\n      value: hi\n  - type: input\n    attributes:\n      label: A\n"
        self.assertEqual([str(h) for h in CHECK_TEMPLATE.parse_template("f.yml", form).headings], ["### A"])

    def test_double_quoted_values_decode_yaml_escapes(self):
        self.assertEqual(
            [CHECK_TEMPLATE.scalar(value) for value in ('"Before\\_after"', '"OS \\x28optional\\x29"', '"\\"q\\" \\\\"')],
            ["Before\xa0after", "OS (optional)", '"q" \\'],
        )

    def test_an_inline_form_body_is_an_error_whatever_its_quoting(self):
        with self.assertRaises(CHECK_TEMPLATE.CheckError):
            CHECK_TEMPLATE.parse_template("f.yml", 'body: [{"type": "input", "attributes": {"label": "Report"}}]\n')

    def test_a_comment_with_a_colon_on_a_dash_line_is_not_a_key(self):
        form = "body:\n  -  # Overview: context\n    type: input\n    attributes:\n      label: A\n"
        self.assertEqual([str(h) for h in CHECK_TEMPLATE.parse_template("f.yml", form).headings], ["### A"])

    def test_escapes_past_the_last_code_point_are_value_errors(self):
        with self.assertRaises(ValueError):
            CHECK_TEMPLATE.scalar('"\\UFFFFFFFF"')

    def test_inline_attributes_with_mismatched_brackets_are_an_error(self):
        self.assertEqual(CHECK_TEMPLATE.flow_mapping("{label: Steps, description: [unfinished}}"), {})

    def test_flow_attributes_opening_on_a_later_line_are_an_error(self):
        with self.assertRaises(CHECK_TEMPLATE.CheckError):
            CHECK_TEMPLATE.parse_template(
                "f.yml", "body:\n  - type: input\n    attributes:\n      {\n        label: Version,\n        description: x }\n"
            )

    def test_a_bracket_line_inside_a_block_value_is_text(self):
        form = "body:\n  - type: markdown\n    attributes:\n      value: |\n        [Read the guide](https://example.org/guide)\n  - type: input\n    attributes:\n      label: A\n"
        self.assertEqual([str(h) for h in CHECK_TEMPLATE.parse_template("f.yml", form).headings], ["### A"])

    def test_issue_form_fields_become_level_three_headings(self):
        template = CHECK_TEMPLATE.parse_template("bug.yml", BUG_FORM)

        self.assertEqual(template.name, "Bug report")
        self.assertEqual(
            [str(heading) for heading in template.headings],
            ["### Version", "### Steps to reproduce", "### Checks"],
        )

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
                "        # Hash",
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
                template.headings, md_headings(body(*sections))
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

    def test_subsection_named_like_a_later_section_does_not_take_its_place(self):
        self.assertEqual(
            self.compare([*FULL[:4], ("### Scope notes", "A subsection."), FULL[4]]),
            [],
        )
        self.assertEqual(
            self.compare([*FULL[:4], ("### Scope notes", "None.")]),
            [("renamed", "## Scope notes", "### Scope notes")],
        )


class SelectTests(unittest.TestCase):
    def test_body_missing_a_heading_still_selects_the_template_it_follows(self):
        smaller = CHECK_TEMPLATE.parse_template("small.md", "## Summary\n\n## Testing\n")
        larger = CHECK_TEMPLATE.parse_template("large.md", "## Summary\n\n## Why\n\n## Testing\n\n## Notes\n")
        found = md_headings(body(("## Summary", "A."), ("## Why", "B."), ("## Testing", "C.")))

        template, problems = CHECK_TEMPLATE.select([smaller, larger], found, None)

        self.assertEqual(template.path, "large.md")
        self.assertEqual([(problem["kind"], problem["expected"]) for problem in problems], [("missing", "## Notes")])


    def test_a_same_level_preference_does_not_shrink_the_kept_headings(self):
        larger = CHECK_TEMPLATE.Template("larger.md", "larger", md_headings("## Summary\n## Rationale\n## Testing\n## Scope\n"))
        smaller = CHECK_TEMPLATE.Template("smaller.md", "smaller", md_headings("## Testing\n## Scope\n"))
        found = md_headings("## Testing\nx\n## Scope\nx\n### Summary\nx\n### Rationale\nx\n### Testing\nx\n")

        template, problems = CHECK_TEMPLATE.select([larger, smaller], found, None)

        self.assertEqual(template.name, "larger")
        self.assertTrue(problems)


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

    def test_a_named_template_is_checked_when_another_cannot_be_read(self):
        self.write(".github/ISSUE_TEMPLATE/default.md", ISSUE_TEMPLATE)
        self.write(".github/ISSUE_TEMPLATE/odd.yml", "name: Odd\nbody: [{type: input, attributes: {label: A}}]\n")
        common = ("--root", str(self.checkout), "--kind", "issue", "--body", "-")

        code, result = self.run_check(*common, "--template-name", "Issue", stdin=body(*FULL))
        self.assertEqual((code, result["state"]), (0, "match"))

        for name in ((), ("--template-name", "odd")):
            with self.subTest(name=name):
                code, result = self.run_check(*common, *name, stdin=body(*FULL))
                self.assertEqual((code, result["state"]), (2, "operational-error"))
                self.assertIn("odd.yml", result["reason"])

    def test_a_root_that_is_not_a_directory_is_an_operational_error(self):
        for root in (self.checkout / "absent", self.write("file.md", "## Summary\n")):
            with self.subTest(root=root.name):
                code, result = self.run_check("--root", str(root), "--kind", "pr", "--body", "-", stdin="## Summary\n")
                self.assertEqual((code, result["state"]), (2, "operational-error"))

    def test_an_explicit_template_without_a_kind_reads_the_body_as_a_pull_request(self):
        template = self.write("template.md", "## Testing\n\nx\n")
        code, result = self.run_check("--template", str(template), "--body", "-", stdin="## Testing\n\n---\n\nEdit: reviewed\n")
        self.assertEqual((code, result["state"]), (1, "mismatch"))

    def test_an_unreadable_form_is_needed_when_its_declared_name_is_chosen(self):
        self.write(".github/ISSUE_TEMPLATE/report.yml", "name: bug-report\nbody:\n  - type: textarea\n    attributes: [odd]\n")
        self.write(".github/ISSUE_TEMPLATE/bug-report.md", "---\nname: Other\n---\n## Summary\n\n-\n")
        code, result = self.run_check(
            "--root", str(self.checkout), "--kind", "issue", "--body", "-", "--template-name", "bug-report",
            stdin="## Summary\n\nText.\n",
        )
        self.assertEqual((code, result["state"]), (2, "operational-error"))
        self.assertIn("report.yml", result["reason"])

    def test_a_template_that_cannot_be_decoded_blocks_every_check(self):
        # Its declared name cannot be read, so it may be the template named.
        self.write(".github/ISSUE_TEMPLATE/default.md", ISSUE_TEMPLATE)
        (self.checkout / ".github/ISSUE_TEMPLATE/other.md").write_bytes(b"\xff\xfe")
        common = ("--root", str(self.checkout), "--kind", "issue", "--body", "-")
        for name in ((), ("--template-name", "Issue")):
            with self.subTest(name=name):
                code, result = self.run_check(*common, *name, stdin=body(*FULL))
                self.assertEqual((code, result["state"]), (2, "operational-error"))
                self.assertIn("other.md", result["reason"])

    def test_a_template_with_an_invalid_escape_blocks_only_a_check_that_needs_it(self):
        self.write(".github/ISSUE_TEMPLATE/default.md", ISSUE_TEMPLATE)
        self.write(".github/ISSUE_TEMPLATE/odd.yml", 'name: Odd\nbody:\n  - type: input\n    attributes: {label: "\\UFFFFFFFF"}\n')
        code, result = self.run_check(
            "--root", str(self.checkout), "--kind", "issue", "--body", "-", "--template-name", "Issue", stdin=body(*FULL)
        )
        self.assertEqual((code, result["state"]), (0, "match"))

    def test_a_form_that_fails_to_parse_keeps_its_declared_name(self):
        self.write(".github/ISSUE_TEMPLATE/form.yml", 'name: Bug report\nbody:\n  - type: input\n    attributes: {label: "\\UFFFFFFFF"}\n')
        self.write(".github/ISSUE_TEMPLATE/bug.md", "---\nname: Bug report\n---\n## Summary\n\n-\n")
        code, result = self.run_check(
            "--root", str(self.checkout), "--kind", "issue", "--body", "-", "--template-name", "Bug report",
            stdin="## Summary\n\nText.\n",
        )
        self.assertEqual((code, result["state"]), (2, "operational-error"))
        self.assertIn("form.yml", result["reason"])

    def test_a_failing_template_keeps_its_declared_name_in_either_format(self):
        for failing in (
            (".github/ISSUE_TEMPLATE/form.yml", '\ufeffname: Bug report\nbody:\n  - type: input\n    attributes: {label: "\\UFFFFFFFF"}\n'),
            (".github/ISSUE_TEMPLATE/other.md", '---\nname: Bug report\nabout: "\\UFFFFFFFF"\n---\n## Summary\n'),
        ):
            with self.subTest(failing=failing[0]):
                self.directory.cleanup()
                self.setUp()
                self.write(*failing)
                self.write(".github/ISSUE_TEMPLATE/bug.md", "---\nname: Bug report\n---\n## Summary\n\n-\n")
                code, result = self.run_check(
                    "--root", str(self.checkout), "--kind", "issue", "--body", "-", "--template-name", "Bug report",
                    stdin="## Summary\n\nText.\n",
                )
                self.assertEqual((code, result["state"]), (2, "operational-error"))

    def test_a_failing_form_whose_name_cannot_be_read_blocks_a_named_check(self):
        self.write(".github/ISSUE_TEMPLATE/report.yml", "body:\n  - type: input\n    attributes: [odd]\n")
        self.write(".github/ISSUE_TEMPLATE/bug.md", "---\nname: Bug report\n---\n## Summary\n\n-\n")
        code, result = self.run_check(
            "--root", str(self.checkout), "--kind", "issue", "--body", "-", "--template-name", "Bug report",
            stdin="## Summary\n\nText.\n",
        )
        self.assertEqual((code, result["state"]), (2, "operational-error"))
        self.assertIn("report.yml", result["reason"])

    def test_a_body_github_cannot_render_is_an_operational_error(self):
        self.scenario.write_text(json.dumps({"render-error": "gh: Bad credentials (HTTP 401)"}), encoding="utf-8")
        template = self.write("template.md", ISSUE_TEMPLATE)
        code, result = self.run_check("--template", str(template), "--body", "-", stdin=body(*FULL))
        self.assertEqual((code, result["state"]), (2, "operational-error"))
        self.assertIn("401", result["reason"])

    def test_a_checkout_without_a_template_never_renders_the_body(self):
        self.scenario.write_text(json.dumps({"render-error": "gh: Server Error (HTTP 500)"}), encoding="utf-8")
        code, result = self.run_check("--root", str(self.checkout), "--kind", "pr", "--body", "-", stdin="## Summary\n")
        self.assertEqual((code, result["state"]), (0, "no-template"))

    def test_a_template_github_fails_to_render_blocks_only_a_check_that_needs_it(self):
        self.write(".github/ISSUE_TEMPLATE/default.md", ISSUE_TEMPLATE)
        self.write(".github/ISSUE_TEMPLATE/other.md", "---\nname: Other\n---\n## Unrenderable\n")
        self.scenario.write_text(json.dumps({"render-error-for": "Unrenderable"}), encoding="utf-8")
        common = ("--root", str(self.checkout), "--kind", "issue", "--body", "-")
        code, result = self.run_check(*common, "--template-name", "Issue", stdin=body(*FULL))
        self.assertEqual((code, result["state"]), (0, "match"))
        code, result = self.run_check(*common, "--template-name", "Other", stdin=body(*FULL))
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
