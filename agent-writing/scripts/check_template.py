#!/usr/bin/env python3
"""Compare an issue or pull request body's headings with the repository template.

Reports template headings that are missing, renamed, out of order or left
empty. Exits 0 when the headings match or no template exists, 1 on a
mismatch and 2 on an operational error.

Markdown headings are read in ATX form (`## Title`). Setext headings and
headings inside list items are not recognized.
"""

from __future__ import annotations

import argparse
import difflib
import json
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

sys.dont_write_bytecode = True  # Keep installed skill trees free of __pycache__.

from check_prose import code_fence


ATX = re.compile(r" {0,3}(#{1,6})(?:[ \t]+(.*))?$")
CLOSING_HASHES = re.compile(r"(?:^|[ \t]+)#+[ \t]*$")
COMMENT = re.compile(r"<!--.*?-->")
# Only a comment that starts a line opens an HTML block that can span lines;
# an unclosed `<!--` later in a line is literal text.
COMMENT_BLOCK = re.compile(r" {0,3}<!--")
BLOCK_SCALAR = re.compile(r"[|>](?:[+-]([0-9])?|([0-9])[+-]?)?(?:\s+#.*)?$")
# A renamed heading still resembles the template's wording this closely.
RENAME_SIMILARITY = 0.6
# GitHub looks for pull request templates in these directories, and for
# several issue templates in `.github/ISSUE_TEMPLATE/`.
TEMPLATE_DIRS = ("", "docs", ".github")


class CheckError(Exception):
    """An input or GitHub problem that prevents the comparison."""


@dataclass
class Heading:
    level: int
    text: str
    line: int
    has_content: bool = False

    def __str__(self) -> str:
        return f"{'#' * self.level} {self.text}"


@dataclass
class Template:
    path: str
    name: str
    headings: list[Heading] = field(default_factory=list)


def headings(text: str) -> list[Heading]:
    """ATX headings outside code blocks, HTML comments and block quotes.

    Each heading records whether its section, up to the next heading of the
    same or a higher level, holds anything a reader sees.
    """
    found: list[Heading] = []
    open_sections: list[Heading] = []
    fence = ""  # The open code block's run of backticks or tildes.
    in_comment = False
    for number, line in enumerate(text.replace("\r\n", "\n").split("\n"), start=1):
        if not fence:
            if in_comment:
                if "-->" not in line:
                    continue
                line = line.split("-->", 1)[1]
                in_comment = False
            line = COMMENT.sub("", line)
            if COMMENT_BLOCK.match(line):
                line, in_comment = "", True
            if not line.strip():
                continue
        fence, in_code = code_fence(fence, line.lstrip())
        match = None if in_code else ATX.match(line)
        if match:
            level = len(match.group(1))
            title = " ".join(CLOSING_HASHES.sub("", match.group(2) or "").split())
            while open_sections and open_sections[-1].level >= level:
                open_sections.pop()
            for section in open_sections:
                section.has_content = True
            heading = Heading(level, title, number)
            found.append(heading)
            open_sections.append(heading)
            continue
        for section in open_sections:
            section.has_content = True
    return found


def front_matter(text: str) -> tuple[dict[str, str], str]:
    """Split a Markdown template's YAML front matter from its body."""
    lines = text.replace("\r\n", "\n").split("\n")
    if not lines or lines[0].strip() != "---":
        return {}, text
    for index, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            fields = {}
            for entry in lines[1:index]:
                key, separator, value = entry.partition(":")
                if separator and not entry.startswith((" ", "\t")):
                    fields[key.strip()] = scalar(value)
            return fields, "\n".join(lines[index + 1 :])
    return {}, text


def scalar(value: str) -> str:
    """A plain or quoted single-line YAML scalar without a trailing comment."""
    value = value.strip()
    double = re.match(r'"(?:[^"\\]|\\.)*"', value)
    if double:
        try:
            return str(json.loads(double.group(0)))
        except ValueError:
            return double.group(0)[1:-1]
    single = re.match(r"'(?:[^']|'')*'", value)
    if single:
        return single.group(0)[1:-1].replace("''", "'")
    return re.sub(r"(?:^|\s+)#.*$", "", value)


def form_template(path: str, text: str) -> Template:
    """Headings of a GitHub issue form: one `###` per non-Markdown field label.

    GitHub renders each answered or empty field as `### <label>` followed by
    the answer or `_No response_`. This reads the block layout issue forms
    use, including folded and literal labels; flow-style YAML is not
    supported, and a form whose labels cannot be read is an error.
    """
    name = Path(path).stem
    found: list[Heading] = []
    in_body = False
    item_indent: int | None = None
    item: dict[str, Any] = {}
    attributes_indent: int | None = None
    label_indent: int | None = None
    block: list[str] | None = None  # Lines of a folded or literal label.
    block_indent: int | None = None  # Set by the block's first line.

    def finish() -> None:
        if item.get("label") and item.get("type") != "markdown":
            found.append(Heading(3, " ".join(item["label"].split()), item["line"]))

    for number, raw in enumerate(text.replace("\r\n", "\n").split("\n"), start=1):
        if not raw.strip():
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        content = raw.strip()
        if block is not None:
            if block_indent is None and label_indent is not None and indent > label_indent:
                block_indent = indent
            # Inside the block a `#` line is text; a less indented line ends it.
            if block_indent is not None and indent >= block_indent:
                block.append(content)
                continue
            item["label"], block = " ".join(block), None
        if content.startswith("#"):
            continue
        # A list item under `body:` may start at the same indent as the key.
        if indent == 0 and not (in_body and content.startswith("- ")):
            key, _, value = content.partition(":")
            if key == "name":
                name = scalar(value) or name
            in_body = key == "body"
            continue
        if not in_body:
            continue
        if content.startswith("- ") and (item_indent is None or indent == item_indent):
            finish()
            item_indent, item = indent, {}
            attributes_indent = label_indent = None
            content, indent = content[2:].lstrip(), indent + 2
        if item_indent is None:
            continue
        key, separator, value = content.partition(":")
        if not separator:
            continue
        key = key.strip()
        if indent == item_indent + 2:
            attributes_indent = indent if key == "attributes" else None
            label_indent = None
            if key == "type":
                item["type"] = scalar(value)
        elif attributes_indent is not None and indent > attributes_indent:
            label_indent = label_indent or indent
            if indent == label_indent and key == "label":
                item["line"] = number
                indicator = BLOCK_SCALAR.match(value.strip())
                if indicator:
                    # An explicit indentation indicator sets the block's indent;
                    # otherwise its first line does.
                    digit = indicator.group(1) or indicator.group(2)
                    block, block_indent = [], indent + int(digit) if digit else None
                else:
                    item["label"] = scalar(value)
    if block is not None:
        item["label"] = " ".join(block)
    finish()
    if not found and re.search(r"\blabel\s*:", text):
        raise CheckError(f"{path}: cannot read the issue form's field labels; pass --template PATH")
    return Template(path, name, found)


def markdown_template(path: str, text: str) -> Template:
    fields, body = front_matter(text)
    return Template(path, fields.get("name") or Path(path).stem, headings(body))


def parse_template(path: str, text: str) -> Template:
    text = text.removeprefix("\ufeff")
    if path.lower().endswith((".yml", ".yaml")):
        return form_template(path, text)
    return markdown_template(path, text)


class Source:
    """Template files in a checkout or, through gh, on a repository's default branch."""

    def __init__(
        self,
        root: Path | None = None,
        repo: str | None = None,
        run: Callable[[list[str]], str | None] | None = None,
    ) -> None:
        self.root = root
        self.repo = repo
        self.run = run

    def entries(self, directory: str) -> list[tuple[str, bool]]:
        """Names in a directory with whether each is a directory; [] when absent."""
        if self.root is not None:
            path = self.root / directory
            if not path.is_dir():
                return []
            return sorted((entry.name, entry.is_dir()) for entry in path.iterdir())
        assert self.run is not None
        endpoint = f"repos/{self.repo}/contents" + (f"/{directory}" if directory else "")
        output = self.run(["api", endpoint])
        if output is None and not directory:
            raise CheckError(f"repository {self.repo} was not found or is not accessible")
        if output is None:
            return []
        listing = json.loads(output)
        if not isinstance(listing, list):
            return []
        return sorted((entry["name"], entry.get("type") == "dir") for entry in listing)

    def read(self, path: str) -> str:
        if self.root is not None:
            return (self.root / path).read_text(encoding="utf-8")
        assert self.run is not None
        output = self.run(
            ["api", "-H", "Accept: application/vnd.github.raw", f"repos/{self.repo}/contents/{path}"]
        )
        if output is None:
            raise CheckError(f"template {path} disappeared from {self.repo}")
        return output


def discover(source: Source, kind: str) -> list[Template]:
    """Every template GitHub would offer for a new issue or pull request."""
    single = "pull_request_template.md" if kind == "pr" else "issue_template.md"
    folder = "pull_request_template" if kind == "pr" else "issue_template"
    suffixes = (".md",) if kind == "pr" else (".md", ".yml", ".yaml")
    paths: list[str] = []
    for directory in TEMPLATE_DIRS:
        for name, is_dir in source.entries(directory):
            path = f"{directory}/{name}" if directory else name
            if not is_dir and name.lower() == single:
                paths.append(path)
            elif is_dir and name.lower() == folder:
                paths.extend(
                    f"{path}/{child}"
                    for child, child_is_dir in source.entries(path)
                    if not child_is_dir
                    and child.lower().endswith(suffixes)
                    # config.yml configures the chooser; it is not a template.
                    and child.lower() not in {"config.yml", "config.yaml"}
                )
    return [parse_template(path, source.read(path)) for path in paths]


def in_order_pairs(expected: list[Heading], actual: list[Heading]) -> list[tuple[int, int]]:
    """The longest run of template headings the body keeps, by text and in order."""
    rows, cols = len(expected), len(actual)
    lengths = [[0] * (cols + 1) for _ in range(rows + 1)]
    for i in range(rows - 1, -1, -1):
        for j in range(cols - 1, -1, -1):
            if expected[i].text == actual[j].text:
                lengths[i][j] = lengths[i + 1][j + 1] + 1
            else:
                lengths[i][j] = max(lengths[i + 1][j], lengths[i][j + 1])
    pairs, i, j = [], 0, 0
    while i < rows and j < cols:
        if expected[i].text == actual[j].text:
            pairs.append((i, j))
            i, j = i + 1, j + 1
        elif lengths[i + 1][j] >= lengths[i][j + 1]:
            i += 1
        else:
            j += 1
    return pairs


def similarity(left: Heading, right: Heading) -> float:
    return difflib.SequenceMatcher(None, left.text.casefold(), right.text.casefold()).ratio()


def compare(expected: list[Heading], actual: list[Heading]) -> list[dict[str, Any]]:
    """Problems with the body's copy of each template heading, in template order.

    Body headings the template does not name, such as subsections, are allowed.
    """
    pairs = in_order_pairs(expected, actual)
    matched = dict(pairs)
    used = set(matched.values())
    problems: list[dict[str, Any]] = []

    def problem(kind: str, index: int, found: Heading | None, detail: str) -> None:
        problems.append({
            "kind": kind,
            "templateIndex": index,
            "expected": str(expected[index]),
            "actual": str(found) if found else None,
            "line": found.line if found else None,
            "detail": detail,
        })

    placed: dict[int, Heading] = {}
    anchors = dict(pairs)  # Template index to body position, kept in order.

    def rename(index: int, position: int) -> None:
        used.add(position)
        placed[index] = actual[position]
        anchors[index] = position
        problem("renamed", index, actual[position], f"{actual[position]} should be {expected[index]}")

    for index, position in pairs:
        placed[index] = actual[position]
        if actual[position].level != expected[index].level:
            problem("renamed", index, actual[position], f"{actual[position]} should be {expected[index]}")

    for index, heading in enumerate(expected):
        if index in matched:
            continue
        position = next(
            (j for j, found in enumerate(actual) if j not in used and found.text == heading.text),
            None,
        )
        if position is None:
            continue
        used.add(position)
        placed[index] = actual[position]
        previous = f"after {expected[index - 1]}" if index else "first"
        problem("out-of-order", index, actual[position], f"{heading} belongs {previous}")
        if actual[position].level != heading.level:
            problem("renamed", index, actual[position], f"{actual[position]} should be {heading}")

    # A renamed heading keeps its place between the headings the body kept in
    # order. Pair the most similar wording first, then a different heading at
    # the same level that stands in the template heading's place.

    def gap(index: int) -> range:
        before = max((j for i, j in anchors.items() if i < index), default=-1)
        after = min((j for i, j in anchors.items() if i > index), default=len(actual))
        return range(before + 1, after)

    scored = sorted(
        (
            (-similarity(heading, actual[j]), index, j)
            for index, heading in enumerate(expected)
            if index not in placed
            for j in gap(index)
            if j not in used and similarity(heading, actual[j]) >= RENAME_SIMILARITY
        ),
    )
    for _, index, position in scored:
        if index in placed or position in used or position not in gap(index):
            continue
        rename(index, position)
    for index, heading in enumerate(expected):
        if index in placed:
            continue
        position = next(
            (j for j in gap(index) if j not in used and actual[j].level == heading.level), None
        )
        if position is None:
            problem("missing", index, None, f"{heading} is missing")
        else:
            rename(index, position)

    for index, found in placed.items():
        if not found.has_content:
            problem("empty", index, found, f"{found} has no content; write None or the reason")

    order = {"missing": 0, "renamed": 1, "out-of-order": 2, "empty": 3}
    problems.sort(key=lambda item: (item["templateIndex"], order[item["kind"]]))
    return problems


def select(
    templates: list[Template], body: list[Heading], name: str | None
) -> tuple[Template, list[dict[str, Any]]]:
    """The named template, or the one the body follows most closely."""
    if name:
        wanted = name.casefold()
        named = [
            template
            for template in templates
            if wanted in {template.name.casefold(), Path(template.path).name.casefold(), Path(template.path).stem.casefold()}
        ]
        if not named:
            choices = ", ".join(template.name for template in templates)
            raise CheckError(f"no template named {name!r}; found: {choices}")
        templates = named
    scored = []
    for template in templates:
        problems = compare(template.headings, body)
        kept = len(in_order_pairs(template.headings, body))
        # Most template headings kept first, so a body missing a heading from
        # the template it follows does not match a smaller template instead.
        scored.append(((-kept, len(problems)), template, problems))
    scored.sort(key=lambda entry: entry[0])
    best_score, best, problems = scored[0]
    tied = [
        template
        for score, template, _ in scored[1:]
        if score == best_score and [str(h) for h in template.headings] != [str(h) for h in best.headings]
    ]
    if tied:
        choices = ", ".join(template.name for template in [best, *tied])
        raise CheckError(f"the body fits several templates equally ({choices}); pass --template-name")
    return best, problems


def gh_runner(args: list[str]) -> str | None:
    """Run gh and return its output, or None for a resource GitHub reports missing."""
    try:
        completed = subprocess.run(
            ["gh", *args], text=True, capture_output=True, timeout=60, check=False
        )
    except FileNotFoundError as error:
        raise CheckError("gh is not installed or not on PATH") from error
    except subprocess.TimeoutExpired as error:
        raise CheckError("gh timed out after 60s") from error
    if completed.returncode != 0:
        message = (completed.stderr or completed.stdout).strip()
        if "HTTP 404" in message:
            return None
        raise CheckError(message or f"gh exited {completed.returncode}")
    return completed.stdout


def live_body(kind: str, number: int, repo: str | None) -> str:
    args = [kind, "view", str(number), "--json", "body"]
    if repo:
        args.extend(["--repo", repo])
    output = gh_runner(args)
    if output is None:
        raise CheckError(f"{kind} #{number} was not found")
    try:
        return str(json.loads(output)["body"] or "")
    except (ValueError, KeyError, TypeError) as error:
        raise CheckError(f"gh returned no body for {kind} #{number}") from error


def checkout_root() -> Path:
    completed = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"], text=True, capture_output=True, check=False
    )
    if completed.returncode != 0:
        raise CheckError("not in a git checkout; pass --root or --repo")
    return Path(completed.stdout.strip())


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    body = result.add_mutually_exclusive_group(required=True)
    body.add_argument("--body", help="body file, or - for standard input")
    body.add_argument("--pr", type=int, help="read the live body of this pull request")
    body.add_argument("--issue", type=int, help="read the live body of this issue")
    result.add_argument("--template", type=Path, help="template file; skips discovery")
    result.add_argument("--template-name", help="template to use among several, by front matter name or file name")
    result.add_argument("--kind", choices=("issue", "pr"), help="template kind to discover for --body")
    result.add_argument("--repo", help="OWNER/REPO for --pr, --issue and, without --root, template discovery")
    result.add_argument("--root", type=Path, help="checkout to discover templates in (default: current checkout)")
    result.add_argument("--json", action="store_true")
    return result


def run(args: argparse.Namespace) -> dict[str, Any]:
    if args.pr is not None:
        source_label, text = f"pr #{args.pr}", live_body("pr", args.pr, args.repo)
    elif args.issue is not None:
        source_label, text = f"issue #{args.issue}", live_body("issue", args.issue, args.repo)
    elif args.body == "-":
        source_label, text = "stdin", sys.stdin.read()
    else:
        source_label = args.body
        try:
            text = Path(args.body).read_text(encoding="utf-8")
        except (OSError, ValueError) as error:
            raise CheckError(f"cannot read body: {error}") from error
    body = headings(text.removeprefix("\ufeff"))

    if args.template:
        try:
            templates = [parse_template(str(args.template), args.template.read_text(encoding="utf-8"))]
        except (OSError, ValueError) as error:
            raise CheckError(f"cannot read template: {error}") from error
        absent = f"{args.template} has no headings"
    else:
        kind = "pr" if args.pr is not None else "issue" if args.issue is not None else args.kind
        if not kind:
            raise CheckError("--kind issue|pr is required to discover a template for --body")
        if args.root or not args.repo:
            source = Source(root=args.root or checkout_root())
        else:
            source = Source(repo=args.repo, run=gh_runner)
        templates = discover(source, kind)
        absent = f"no {kind} template with headings found"
    templates = [template for template in templates if template.headings]
    if not templates:
        return {"state": "no-template", "body": source_label, "problems": [], "reason": absent}

    template, problems = select(templates, body, args.template_name)
    return {
        "state": "mismatch" if problems else "match",
        "body": source_label,
        "template": {"path": template.path, "name": template.name, "headings": [str(h) for h in template.headings]},
        "problems": problems,
        "reason": f"{len(problems)} heading problem(s)" if problems else "headings match the template",
    }


def main() -> int:
    args = parser().parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")  # A label the terminal cannot encode.
    try:
        result = run(args)
    # A check that could not run must not read as a mismatch to fix.
    except (CheckError, OSError, ValueError, KeyError, TypeError) as error:
        result = {"state": "operational-error", "problems": [], "reason": str(error)}
    if args.json:
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    else:
        if "template" in result:
            print(f"template: {result['template']['path']} ({result['template']['name']})")
        for problem in result["problems"]:
            print(f"{problem['kind']}: {problem['detail']}")
        print(f"{result['state']}: {result['reason']}")
    return {"match": 0, "no-template": 0, "mismatch": 1}.get(result["state"], 2)


if __name__ == "__main__":
    sys.exit(main())
