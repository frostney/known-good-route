#!/usr/bin/env python3
"""Compare an issue or pull request body's headings with the repository template.

Reports template headings that are missing, renamed, out of order or left
empty. Exits 0 when the headings match or no template exists, 1 on a
mismatch and 2 on an operational error.

Markdown bodies and templates are read as GitHub renders them, through its
Markdown API, so a heading counts only where GitHub shows one. A heading
inside a list item, quote, table or alert is that section's content, not a
section of its own.
"""

from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

sys.dont_write_bytecode = True  # Keep installed skill trees free of __pycache__.


HEADING_TAG = re.compile(r"h([1-6])")
# Elements whose headings are their section's content rather than sections.
NESTING = {"li", "blockquote", "table", "pre", "code", "summary"}
MEDIA = {"img", "video", "audio", "picture", "iframe", "object", "embed"}
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}
# The attribution note `create-issue` ends every issue with, as rendered text.
ATTRIBUTION = re.compile(r"Created on behalf of @[\w-]+ using (?:(?!\.\s).)+\.")
YAML_KEY = re.compile(r"""(?:[A-Za-z0-9_][\w .-]*|"[^"]*"|'[^']*')[ \t]*:(?:[ \t]|$)""")
BLOCK_SCALAR = re.compile(r"[|>](?:[+-]([0-9])?|([0-9])[+-]?)?(?:\s+#.*)?$")
# A renamed heading still resembles the template's wording this closely.
RENAME_SIMILARITY = 0.6
# GitHub looks for pull request templates in these directories, and for
# several issue templates in `.github/ISSUE_TEMPLATE/`.
TEMPLATE_DIRS = ("", "docs", ".github")


class CheckError(Exception):
    """An input or GitHub problem that prevents the comparison."""

    path = ""  # The template file the problem is in, when there is one.
    name = ""  # That template's declared name, when it was read.


@dataclass
class Heading:
    level: int
    text: str
    line: int | None = None  # A form field's line; rendered Markdown has none.
    has_content: bool = False

    def __str__(self) -> str:
        return f"{'#' * self.level} {self.text}"


@dataclass
class Template:
    path: str
    name: str
    headings: list[Heading] = field(default_factory=list)


@dataclass
class Node:
    tag: str
    attrs: dict[str, str]
    children: list[Node | str] = field(default_factory=list)


class TreeBuilder(HTMLParser):
    """A tree of GitHub's rendered HTML; comments, which it never renders, are dropped."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = Node("root", {})
        self.stack = [self.root]

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "br":
            self.stack[-1].children.append("\n")  # A line break separates words and lines.
            return
        node = Node(tag, {key: value or "" for key, value in attrs})
        self.stack[-1].children.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                return

    def handle_data(self, data: str) -> None:
        self.stack[-1].children.append(data)


def text_of(node: Node | str) -> str:
    if isinstance(node, str):
        return node
    if node.tag == "img":
        return node.attrs.get("alt", "")  # A badge or image reads as its label.
    return "".join(text_of(child) for child in node.children)


def words(node: Node | str) -> str:
    return " ".join(text_of(node).split())


def elements(nodes: list[Node | str]) -> list[Node]:
    return [node for node in nodes if isinstance(node, Node)]


def has_media(node: Node) -> bool:
    return any(child.tag in MEDIA or has_media(child) for child in elements(node.children))


def is_alert(node: Node) -> bool:
    return node.tag == "div" and "markdown-alert" in node.attrs.get("class", "").split()


def names_head(paragraph: Node) -> bool:
    """Whether a paragraph's first line opens with `Edit:` and names a commit in code."""
    if not words(paragraph).startswith("Edit:"):
        return False
    for child in paragraph.children:
        if isinstance(child, str) and "\n" in child:
            return False  # The first line ended without naming a commit.
        if isinstance(child, Node) and child.tag == "code" and re.fullmatch(r"[0-9a-f]{4,40}", words(child)):
            return True
    return False


def is_footnotes(node: Node) -> bool:
    """The footnotes section GitHub appends, with its generated heading."""
    return node.tag == "section" and ("data-footnotes" in node.attrs or "footnotes" in node.attrs.get("class", "").split())


def is_checked(node: Node) -> bool:
    return node.tag == "input" and "checked" in node.attrs


def has_checked(node: Node) -> bool:
    return any(is_checked(child) or has_checked(child) for child in elements(node.children))


def headings(html: str, kind: str | None = None) -> list[Heading]:
    """Headings of rendered HTML, each with whether its section shows anything.

    A section runs to the next heading of the same or a higher level. A list
    item that shows nothing, or only `[ ]`, is a template placeholder, not
    content. For a pull request, reading stops at a review note: a rule
    followed by a paragraph that opens with `Edit:`. For an issue, the
    attribution note that closes it is not content.
    """
    builder = TreeBuilder()
    builder.feed(html)
    builder.close()
    # GitHub appends footnotes after the last section; they are no section's content.
    top = [node for node in builder.root.children if not (isinstance(node, Node) and is_footnotes(node))]
    blocks = elements(top)
    if kind == "pr":
        # The review note closes the body: a rule, then a line that opens with
        # `Edit:` and names the head it covers in code, such as
        # ``Edit: `1a2b3c4` reviewed``.
        for rule, following in reversed(list(zip(blocks, blocks[1:]))):
            if rule.tag == "hr" and following.tag == "p" and names_head(following):
                top = top[: next(index for index, node in enumerate(top) if node is rule)]
                break
    if kind == "issue" and blocks:
        last = blocks[-1]
        paragraphs = [node for node in elements(last.children) if "markdown-alert-title" not in node.attrs.get("class", "")]
        lines = [line for line in text_of(paragraphs[0]).splitlines() if line.strip()] if len(paragraphs) == 1 else []
        if (
            "markdown-alert-note" in last.attrs.get("class", "").split()
            and len(lines) == 1
            and ATTRIBUTION.fullmatch(" ".join(lines[0].split()))
        ):
            top = [node for node in top if node is not last]

    found: list[Heading] = []
    open_sections: list[Heading] = []

    def content() -> None:
        for section in open_sections:
            section.has_content = True

    def visit(children: list[Node | str], nested: bool) -> None:
        for child in children:
            if isinstance(child, str):
                if child.strip():
                    content()
                continue
            level = HEADING_TAG.fullmatch(child.tag)
            if level and not nested:
                heading = Heading(int(level.group(1)), words(child))
                while open_sections and open_sections[-1].level >= heading.level:
                    open_sections.pop()
                content()  # A subsection is content of the sections around it.
                found.append(heading)
                open_sections.append(heading)
                continue
            if child.tag == "li":
                lists = [node for node in elements(child.children) if node.tag in ("ul", "ol")]
                own = Node("li", {}, [node for node in child.children if not any(node is nested_list for nested_list in lists)])
                if words(own) in ("", "[ ]") and not has_media(own) and not has_checked(own):
                    visit(lists, True)
                    continue
            if child.tag in MEDIA or is_checked(child):
                content()
            visit(child.children, nested or child.tag in NESTING or is_alert(child))

    visit(top, False)
    return found


def target_host(repo: str | None) -> str | None:
    """The host of the repository the check is about, resolved the way gh resolves it.

    A host-qualified `--repo` or `GH_REPO` names it; gh resolves a repository
    named without a host, and otherwise the repository of the current
    checkout. None, outside any checkout, leaves the host to gh.
    """
    named = repository(repo or os.environ.get("GH_REPO")) or ""
    if named.count("/") == 2:
        return canonical_host(named.split("/")[0])
    if named:
        try:
            url = gh_runner(["repo", "view", named, "--json", "url", "--jq", ".url"])
        except CheckError as error:
            raise CheckError(f"cannot resolve the GitHub host of {named}: {error}") from error
        host = urlparse((url or "").strip()).hostname
        if not host:
            raise CheckError(f"cannot resolve the GitHub host of {named}")
        return canonical_host(host)
    return checkout_host(None, os.environ)


def canonical_host(host: str) -> str:
    """A host as gh spells it: lowercase, and www.github.com is github.com."""
    host = host.lower()
    return "github.com" if host == "www.github.com" else host


def checkout_host(root: Path | None, env: dict[str, str] | os._Environ[str]) -> str | None:
    """The host of the repository gh resolves for a checkout; None outside any checkout.

    A git checkout gh cannot place is an operational error: it belongs to some
    host, or to none yet, and Markdown is never sent to a guessed one.
    """
    reason = "gh found no repository"
    try:
        url = gh_runner(["repo", "view", "--json", "url", "--jq", ".url"], cwd=root, env=dict(env))
    except CheckError as error:
        url, reason = None, str(error)
    if url and urlparse(url.strip()).hostname:
        return canonical_host(urlparse(url.strip()).hostname)
    inside = subprocess.run(
        ["git", *(["-C", str(root)] if root else []), "rev-parse", "--is-inside-work-tree"],
        text=True, capture_output=True, check=False,
    )
    if inside.returncode == 0 and inside.stdout.strip() == "true":
        raise CheckError(
            f"cannot tell which GitHub host this checkout belongs to ({reason}); pass --repo HOST/OWNER/REPO"
        )
    return None


def same_host(root: Path, host: str | None) -> str | None:
    """Refuse templates from a checkout on another host than the body's; return the host.

    The checkout is placed by its own remotes, without GH_REPO or GH_HOST; only
    when that fails is GH_HOST kept, for an Enterprise host configured through it.
    """
    environment = {key: value for key, value in os.environ.items() if key not in ("GH_REPO", "GH_HOST")}
    try:
        own = checkout_host(root, environment)
    except CheckError as error:
        # Retry with GH_HOST only when gh knew no host for the remotes; any other
        # failure leaves the checkout unplaced, and nothing is rendered.
        if "GH_HOST" not in os.environ or "known GitHub host" not in str(error):
            raise
        own = checkout_host(root, {**environment, "GH_HOST": os.environ["GH_HOST"]})
    if host is None:
        return own
    if own is not None and own != host:
        raise CheckError(
            f"the templates in {root} belong to {own}, but the body belongs to {host}; "
            "check them against a body on the same host"
        )
    return host


def render(markdown: str, host: str | None = None) -> str:
    """Markdown as GitHub renders it in an issue or pull request, on that host."""
    if not markdown.strip():
        return ""
    route = ["--hostname", host] if host else []
    output = gh_runner(["api", *route, "markdown", "--input", "-"], json.dumps({"text": markdown, "mode": "gfm"}))
    if output is None:
        raise CheckError("GitHub's Markdown API is not available")
    return output


def front_matter(text: str) -> tuple[dict[str, str], str]:
    """Split a Markdown template's YAML front matter from its body."""
    lines = text.replace("\r\n", "\n").split("\n")
    if not lines or lines[0].strip() != "---":
        return {}, text
    for index, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            block = [entry for entry in lines[1:index] if entry.strip() and not re.match(r"\.\.\.(?:[ \t]+#.*)?[ \t]*$", entry)]
            # Front matter holds YAML keys; an opening `---` rule over Markdown
            # is part of the body.
            if not any(YAML_KEY.match(entry) for entry in block):
                return {}, text
            fields = {}
            for entry in block:
                key, separator, value = entry.partition(":")
                if separator and not entry.startswith((" ", "\t")):
                    fields[key.strip()] = scalar(value)
            return fields, "\n".join(lines[index + 1 :])
    return {}, text


# YAML's double-quoted escapes: a character, or a code point in hex.
YAML_ESCAPE = re.compile(r"\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|.)")
YAML_ESCAPES = {
    "0": "\0", "a": "\a", "b": "\b", "t": "\t", "\t": "\t", "n": "\n", "v": "\v", "f": "\f",
    "r": "\r", "e": "\x1b", " ": " ", '"': '"', "/": "/", "\\": "\\", "N": "\x85",
    "_": "\xa0", "L": "\u2028", "P": "\u2029",
}


def yaml_escape(match: re.Match[str]) -> str:
    code = match.group(1)
    if len(code) == 1:
        return YAML_ESCAPES[code]
    point = int(code[1:], 16)
    if point > sys.maxunicode:
        raise ValueError(f"escape \\{code} is past the last Unicode code point")
    return chr(point)


def scalar(value: str) -> str:
    """A plain or quoted single-line YAML scalar without a trailing comment."""
    value = value.strip()
    double = re.match(r'"(?:[^"\\]|\\.)*"', value)
    if double:
        inner = double.group(0)[1:-1]
        try:
            return YAML_ESCAPE.sub(yaml_escape, inner)
        except KeyError:
            return inner  # An escape YAML does not define; compare the text as written.
    single = re.match(r"'(?:[^']|'')*'", value)
    if single:
        return single.group(0)[1:-1].replace("''", "'")
    return re.sub(r"(?:^|\s+)#.*$", "", value)


# A quoted key and its colon, which a quoted value may follow with no space.
QUOTED_KEY = re.compile(r"""(?:^|[\[{,\s])(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')[ \t]*:$""")


def scan(text: str, separator: str) -> tuple[list[str], bool]:
    """Split text at each separator outside quotes and nested brackets.

    Also returns whether every bracket and quote that opens in text closes in
    it. A quote opens a quoted scalar only where a scalar starts, so the
    apostrophe in a plain `What's wrong?` is text. Inside quotes, `\\"` and
    `''` escape the closing quote.
    """
    parts, current, opened, quote, escaped, closed = [], "", "", "", False, True
    for index, char in enumerate(text):
        if escaped:
            escaped = False
        elif quote == '"' and char == "\\":
            escaped = True
        elif quote == "'" and char == "'" and text[index + 1 : index + 2] == "'":
            escaped = True
        elif quote:
            quote = "" if char == quote else quote
        elif char in "\"'" and (
            not current.strip()
            or current.rstrip()[-1] in "[{,"
            or current.rstrip()[-1] == ":" and (current[-1].isspace() or QUOTED_KEY.search(current))
        ):
            quote = char
        elif char in "{[":
            opened += char
        elif char in "}]":
            closed = closed and opened[-1:] == ("{" if char == "}" else "[")
            opened = opened[:-1]
        elif char == separator and not opened:
            parts.append(current)
            current = ""
            continue
        current += char
    return [*parts, current], closed and not opened and not quote


def top_level(text: str, separator: str) -> list[str]:
    return scan(text, separator)[0]


def flow_mapping(text: str) -> dict[str, str]:
    """The entries of a one-line YAML flow mapping such as `{label: Steps}`.

    A comma or colon inside a quoted value or a nested bracket belongs to that
    value. A comment may follow the closing brace. Anything that is not a
    closed flow mapping reads as empty.
    """
    text = top_level(text, "#")[0].strip()
    if not (text.startswith("{") and text.endswith("}")) or not scan(text[1:-1], ",")[1]:
        return {}
    found = {}
    for entry in top_level(text[1:-1], ","):
        # A key ends where YAML ends one: at a colon followed by a space, or
        # straight after a quoted key.
        parts = top_level(entry, ":")
        for index in range(1, len(parts)):
            key = ":".join(parts[:index])
            if not parts[index] or parts[index][0].isspace() or QUOTED_KEY.search(key + ":"):
                found[scalar(key)] = scalar(":".join(parts[index:]))
                break
    return found


def declared_name(text: str) -> str:
    """A form's top-level `name`, plain, quoted or as a folded or literal block."""
    lines = text.replace("\r\n", "\n").split("\n")
    for index, line in enumerate(lines):
        key, separator, value = line.partition(":")
        if not separator or line.startswith((" ", "\t", "-")) or scalar(key) != "name":
            continue
        if scalar(value) and not BLOCK_SCALAR.match(value.strip()):
            return scalar(value)
        # A block scalar, or a plain one continued on the lines below the key.
        block = []
        for following in lines[index + 1 :]:
            if following.strip() and not following.startswith((" ", "\t")):
                break
            block.append(following.strip())
        joined = " ".join(" ".join(block).split())
        return joined if BLOCK_SCALAR.match(value.strip()) else scalar(joined)
    if text.lstrip().startswith("{"):
        return flow_mapping(" ".join(line.strip() for line in lines)).get("name", "")
    return ""


def form_template(path: str, text: str) -> Template:
    """Headings of a GitHub issue form: one `###` per non-Markdown field label.

    GitHub renders each answered or empty field as `### <label>` followed by
    the answer or `_No response_`. This reads the block layout issue forms
    use, including folded and literal labels and a field's `attributes`
    written as a flow mapping. Any other flow-style YAML is not supported: a
    form with a field whose label cannot be read is an error, so a body is
    never checked against part of a form.
    """
    # The declared name comes first, so an error in a field still carries it.
    declared = declared_name(text)
    name = declared or Path(path).stem
    found: list[Heading] = []
    in_body = False
    item_indent: int | None = None
    key_indent: int | None = None  # Column of the current field's keys.
    item: dict[str, Any] = {}
    attributes_indent: int | None = None
    label_indent: int | None = None
    block: list[str] | None = None  # Lines of a folded or literal label.
    block_indent: int | None = None  # Set by the block's first line.

    def finish() -> None:
        if not item or item.get("type") == "markdown":
            return
        if not item.get("label"):
            error = CheckError(
                f"{path}: cannot read the label of the field on line {item['start']}; pass --template PATH"
            )
            error.name = name
            raise error
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
        starts_item = bool(re.match(r"-(?:[ \t]|$)", content))
        if indent == 0 and not (in_body and starts_item):
            key, _, value = content.partition(":")
            in_body = scalar(key) == "body"
            if in_body and value.strip() and not value.strip().startswith("#"):
                error = CheckError(f"{path}: cannot read the issue form's body on line {number}; pass --template PATH")
                error.name = name
                raise error
            continue
        if not in_body:
            continue
        if starts_item and (item_indent is None or indent == item_indent):
            finish()
            item_indent, item = indent, {"start": number}
            attributes_indent = label_indent = None
            pad = 1 + len(content[1:]) - len(content[1:].lstrip())
            # After a bare or comment-only dash, the first key sets the column.
            key_indent = None if content[1:].strip().startswith("#") or not content[1:].strip() else indent + pad
            content, indent = content[1:].lstrip(), indent + pad
            if content.startswith("#"):
                continue
            # Only a field's attributes may be a flow mapping, not the field.
            if content.startswith(("{", "[")):
                error = CheckError(f"{path}: cannot read the field on line {number}; pass --template PATH")
                error.name = name
                raise error
        if item_indent is None:
            continue
        # Flow-style attributes that open on a later line are unsupported.
        if (
            attributes_indent is not None
            and label_indent is None
            and indent > attributes_indent
            and content.startswith(("{", "["))
        ):
            error = CheckError(f"{path}: cannot read the attributes on line {number}; pass --template PATH")
            error.name = name
            raise error
        key, separator, value = content.partition(":")
        if not separator or not (value[:1].isspace() or not value):
            # A type or label may continue as a plain scalar below its key.
            pending = item.pop("pending", None)
            if pending and indent > pending[1]:
                item[pending[0]] = scalar(content)
                if pending[0] == "label":
                    item["line"] = number
            continue
        item.pop("pending", None)
        key = scalar(key)
        if key_indent is None and indent > item_indent:
            key_indent = indent
        if indent == key_indent:
            attributes_indent = indent if key == "attributes" else None
            label_indent = None
            if key == "type":
                item["type"] = "" if BLOCK_SCALAR.match(value.strip()) else scalar(value)
                if not item["type"]:
                    item["pending"] = ("type", indent)
            elif key == "attributes" and value.strip().startswith("{"):
                attributes_indent = None
                mapping = flow_mapping(value.strip())
                if not mapping:
                    error = CheckError(
                        f"{path}: cannot read the attributes on line {number}; pass --template PATH"
                    )
                    error.name = name
                    raise error
                if mapping.get("label"):
                    item["line"], item["label"] = number, mapping["label"]
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
                    if not scalar(value):
                        item["pending"] = ("label", indent)
    if block is not None:
        item["label"] = " ".join(block)
    finish()
    if not found and re.search(r"""\b["']?label["']?\s*:""", text):
        error = CheckError(f"{path}: cannot read the issue form's field labels; pass --template PATH")
        error.name = name
        raise error
    return Template(path, name, found)


def markdown_template(path: str, text: str, renderer: Callable[[str], str]) -> Template:
    fields, body = front_matter(text)
    return Template(path, fields.get("name") or Path(path).stem, headings(renderer(body)))


def parse_template(path: str, text: str, renderer: Callable[[str], str] | None = None) -> Template:
    text = text.removeprefix("\ufeff")
    renderer = renderer or render
    if path.lower().endswith((".yml", ".yaml")):
        template = form_template(path, text)
        # GitHub shows each label as a rendered heading, so compare it as one.
        if template.headings:
            shown = headings(renderer("\n\n".join(f"### {heading.text}" for heading in template.headings)))
            if len(shown) == len(template.headings):
                for heading, rendered in zip(template.headings, shown):
                    heading.text = rendered.text
        return template
    return markdown_template(path, text, renderer)


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
        # A host-qualified HOST/OWNER/REPO sends each request to that host.
        parts = (repo or "").split("/")
        self.slug = "/".join(parts[-2:])
        self.route = ["--hostname", parts[0]] if len(parts) == 3 else []

    def entries(self, directory: str) -> list[tuple[str, bool]]:
        """Names in a directory with whether each is a directory; [] when absent."""
        if self.root is not None:
            path = self.root / directory
            if not path.is_dir():
                return []
            return sorted((entry.name, entry.is_dir()) for entry in path.iterdir())
        assert self.run is not None
        endpoint = f"repos/{self.slug}/contents" + (f"/{directory}" if directory else "")
        output = self.run(["api", *self.route, endpoint])
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
            resolved = (self.root / path).resolve()
            # A symlink may point anywhere; only the checkout's own files are read.
            if not resolved.is_relative_to(self.root.resolve()):
                raise CheckError(f"template {path} resolves outside the checkout")
            return resolved.read_text(encoding="utf-8")
        assert self.run is not None
        output = self.run(
            ["api", *self.route, "-H", "Accept: application/vnd.github.raw", f"repos/{self.slug}/contents/{path}"]
        )
        if output is None:
            raise CheckError(f"template {path} disappeared from {self.repo}")
        return output


def may_be_named(path: str, text: str, name: str) -> bool:
    """Whether a template can be the one named; one whose name cannot be read may be."""
    wanted = name.casefold()
    if wanted in {Path(path).name.casefold(), Path(path).stem.casefold()}:
        return True
    try:
        text = text.removeprefix("\ufeff")
        if path.lower().endswith((".yml", ".yaml")):
            declared = declared_name(text)
        else:
            declared = front_matter(text)[0].get("name", "")
    except ValueError:
        return True
    return (declared or Path(path).stem).casefold() == wanted


def discover(
    source: Source, kind: str, renderer: Callable[[str], str] | None = None, wanted: str | None = None
) -> list[Template | CheckError]:
    """Every template GitHub would offer for a new issue or pull request.

    A template that cannot be read is returned as its error, so it blocks only
    a check that needs it.
    """
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
    found: list[Template | CheckError] = []
    skipped: list[str] = []
    for path in paths:
        try:
            try:
                text = source.read(path)
            except (OSError, ValueError) as error:
                raise CheckError(f"cannot read template {path}: {error}") from error
            if wanted and not may_be_named(path, text, wanted):
                skipped.append(path)
                continue  # Never rendered: it cannot be the template named.
            try:
                found.append(parse_template(path, text, renderer))
            except CheckError as error:
                # Keep the declared name, so a check naming another template ignores it.
                if not error.name:
                    try:
                        if path.lower().endswith((".yml", ".yaml")):
                            error.name = declared_name(text.removeprefix("\ufeff"))
                        else:
                            fields = front_matter(text.removeprefix("\ufeff"))[0]
                            error.name = fields.get("name") or Path(path).stem
                    except ValueError:
                        pass
                raise
            except ValueError as error:
                failure = CheckError(f"cannot read template {path}: {error}")
                # Keep the form's declared name, so a check that names it still sees the error.
                # Only the name line is read, so the field that failed cannot fail it too.
                try:
                    failure.name = declared_name(text.removeprefix("\ufeff"))
                except ValueError:
                    failure.name = ""
                raise failure from error
        except CheckError as error:
            error.path = path
            found.append(error)
    if wanted and skipped and not found:
        raise CheckError(f"no template named {wanted!r}; found: {', '.join(skipped)}")
    return found


def named(template: Template, name: str) -> bool:
    path = Path(template.path)
    return name.casefold() in {template.name.casefold(), path.name.casefold(), path.stem.casefold()}


def readable(found: list[Template | CheckError], name: str | None) -> list[Template]:
    """The templates a check can use, raising the error of one it needs.

    Without a name every template competes, so any unreadable one is needed.
    With a name, an unreadable template is needed when its file or declared
    name is that name, when its declared name could not be read, or when no
    readable template has it.
    """
    templates = [entry for entry in found if isinstance(entry, Template)]
    failures = [entry for entry in found if isinstance(entry, CheckError)]
    if not failures:
        return templates
    if not name:
        raise failures[0]
    for failure in failures:
        path = Path(failure.path)
        # A template whose declared name is unknown may be the one named.
        if not failure.name or name.casefold() in {
            failure.name.casefold(), path.name.casefold(), path.stem.casefold()
        }:
            raise failure
    if not any(named(template, name) for template in templates):
        raise failures[0]
    return templates


def in_order_pairs(expected: list[Heading], actual: list[Heading]) -> list[tuple[int, int]]:
    """The longest run of template headings the body keeps, by text and in order.

    Among runs of that length, the one with the most headings at their
    template level wins, so a subsection that shares a section's name does not
    take that section's place; text alone still pairs a heading whose level
    changed.
    """
    rows, cols = len(expected), len(actual)
    # One more pair always outweighs every same-level bonus together.
    pair_weight = min(rows, cols) + 1

    def weight(i: int, j: int) -> int:
        if expected[i].text != actual[j].text:
            return 0
        return pair_weight + (expected[i].level == actual[j].level)

    lengths = [[0] * (cols + 1) for _ in range(rows + 1)]
    for i in range(rows - 1, -1, -1):
        for j in range(cols - 1, -1, -1):
            best = max(lengths[i + 1][j], lengths[i][j + 1])
            if weight(i, j):
                best = max(best, lengths[i + 1][j + 1] + weight(i, j))
            lengths[i][j] = best
    pairs, i, j = [], 0, 0
    while i < rows and j < cols:
        if weight(i, j) and lengths[i][j] == lengths[i + 1][j + 1] + weight(i, j):
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
        chosen = [template for template in templates if named(template, name)]
        if not chosen:
            choices = ", ".join(template.name for template in templates)
            raise CheckError(f"no template named {name!r}; found: {choices}")
        templates = chosen
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


def gh_runner(
    args: list[str], stdin: str | None = None, cwd: Path | None = None, env: dict[str, str] | None = None
) -> str | None:
    """Run gh and return its output, or None for a resource GitHub reports missing."""
    try:
        completed = subprocess.run(
            ["gh", *args], input=stdin, cwd=cwd, env=env, text=True, encoding="utf-8",
            capture_output=True, timeout=60, check=False,
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


def live_body(kind: str, number: int, repo: str | None) -> tuple[str, str]:
    """A live body and the host gh fetched it from, by the URL gh returns."""
    args = [kind, "view", str(number), "--json", "body,url"]
    if repo:
        args.extend(["--repo", repo])
    output = gh_runner(args)
    if output is None:
        raise CheckError(f"{kind} #{number} was not found")
    try:
        data = json.loads(output)
        host = urlparse(data["url"]).hostname
        if not host:
            raise ValueError("no host")
        return str(data["body"] or ""), canonical_host(host)
    except (ValueError, KeyError, TypeError) as error:
        raise CheckError(f"gh returned no body or URL for {kind} #{number}") from error


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


def template_checkout(path: Path) -> Path | None:
    """The checkout a template path lies in, refusing one that resolves outside it."""
    located = subprocess.run(
        ["git", "-C", str(path.absolute().parent), "rev-parse", "--show-toplevel"],
        text=True, capture_output=True, check=False,
    )
    if located.returncode != 0:
        return None  # A standalone file: it renders on the body's host.
    root = Path(located.stdout.strip())
    if not path.resolve().is_relative_to(root.resolve()):
        raise CheckError(f"template {path} resolves outside its checkout")
    return root


def repository(name: str | None) -> str | None:
    """OWNER/REPO or HOST/OWNER/REPO, also from a repository URL gh accepts."""
    if name and "://" not in name and name.count("/") == 2:
        host, slug = name.split("/", 1)
        return f"{canonical_host(host)}/{slug}"
    if not name or "://" not in name:
        return name
    url = urlparse(name)
    path = url.path.strip("/").removesuffix(".git")
    if not url.hostname or path.count("/") != 1:
        raise CheckError(f"--repo {name} names no repository")
    return f"{canonical_host(url.hostname)}/{path}"


def run(args: argparse.Namespace) -> dict[str, Any]:
    args.repo = repository(args.repo)
    live_host: str | None = None
    if args.pr is not None:
        source_label, (text, live_host) = f"pr #{args.pr}", live_body("pr", args.pr, args.repo)
    elif args.issue is not None:
        source_label, (text, live_host) = f"issue #{args.issue}", live_body("issue", args.issue, args.repo)
    elif args.body == "-":
        source_label, text = "stdin", sys.stdin.read()
    else:
        source_label = args.body
        try:
            text = Path(args.body).read_text(encoding="utf-8")
        except (OSError, ValueError) as error:
            raise CheckError(f"cannot read body: {error}") from error
    kind = "pr" if args.pr is not None else "issue" if args.issue is not None else args.kind
    # Everything renders on one host: that of the repository the check is about.
    # A template from a checkout must belong to that host too. The host is
    # resolved only when something is rendered.
    hosts: dict[str, str | None] = {}
    checked: set[Path] = set()

    def host() -> str | None:
        if "host" not in hosts:
            hosts["host"] = live_host or target_host(args.repo)
        return hosts["host"]

    def renderer_for(root: Path | None) -> Callable[[str], str]:
        def renderer(markdown: str) -> str:
            if not markdown.strip():
                return ""
            if root is not None and root.resolve() not in checked:
                # Outside any checkout, the templates' checkout names the host.
                hosts["host"] = same_host(root, host())
                checked.add(root.resolve())
            return render(markdown, host())

        return renderer

    if args.template:
        try:
            renderer = renderer_for(template_checkout(args.template))
            templates = [parse_template(str(args.template), args.template.read_text(encoding="utf-8"), renderer)]
        except (OSError, ValueError) as error:
            raise CheckError(f"cannot read template: {error}") from error
        absent = f"{args.template} has no headings"
    else:
        if not kind:
            raise CheckError("--kind issue|pr is required to discover a template for --body")
        if args.root and not args.root.is_dir():
            raise CheckError(f"--root {args.root} is not a directory")
        if args.root or not args.repo:
            source = Source(root=args.root or checkout_root())
        else:
            source = Source(repo=args.repo, run=gh_runner)
        templates = readable(discover(source, kind, renderer_for(source.root), args.template_name), args.template_name)
        absent = f"no {kind} template with headings found"
    templates = [template for template in templates if template.headings]
    if not templates:
        return {"state": "no-template", "body": source_label, "problems": [], "reason": absent}

    # Without a kind, as with --template alone, the body reads as a pull request's.
    text = text.removeprefix("\ufeff")
    body = headings(render(text, host()) if text.strip() else "", kind or "pr")
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
    except Exception as error:  # A defect in this checker is no verdict on the body either.
        result = {"state": "operational-error", "problems": [], "reason": f"checker failed: {error!r}"}
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
