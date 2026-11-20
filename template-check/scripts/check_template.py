#!/usr/bin/env python3
"""Compare an issue or pull request body's headings with the repository template.

Reports template headings that are missing, renamed, out of order or left
empty. Exits 0 when the headings match or no template exists, 1 on a
mismatch and 2 on an operational error.

Markdown bodies and templates are rendered locally with cmark-gfm, the engine
behind GitHub's Markdown, so a heading counts only where GitHub shows one. A heading
inside a list item, quote, table or alert is that section's content, not a
section of its own.
"""

from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

sys.dont_write_bytecode = True  # Keep installed skill trees free of __pycache__.

try:
    import cmarkgfm
    from cmarkgfm.cmark import Options
except ImportError:  # render() runs it through uv instead.
    cmarkgfm = None

# GitHub's cmark-gfm for Python, pinned to a release over a year old.
CMARKGFM = "cmarkgfm==2025.10.22"
# uv settings that name a package source or a directory; the fallback clears them so
# PyPI is the only source and the temporary directory the only working directory.
UV_SOURCES = {
    "UV_INDEX", "UV_INDEX_URL", "UV_DEFAULT_INDEX", "UV_EXTRA_INDEX_URL", "UV_FIND_LINKS", "UV_NO_INDEX",
    "UV_INDEX_STRATEGY", "UV_CONFIG_FILE", "UV_KEYRING_PROVIDER", "UV_WORKING_DIR", "UV_PROJECT",
}
# Raw HTML is kept, as GitHub keeps it before filtering the tags it never shows.
RENDER = (
    "import sys, cmarkgfm\n"
    "from cmarkgfm.cmark import Options\n"
    "markdown = sys.stdin.buffer.read().decode('utf-8')\n"
    "html = cmarkgfm.github_flavored_markdown_to_html(markdown, "
    "options=Options.CMARK_OPT_UNSAFE | Options.CMARK_OPT_FOOTNOTES | Options.CMARK_OPT_SOURCEPOS)\n"
    "sys.stdout.buffer.write(html.encode('utf-8'))"
)


HEADING_TAG = re.compile(r"h([1-6])")
# Elements whose headings are their section's content rather than sections.
NESTING = {"li", "blockquote", "table", "pre", "code", "summary"}
MEDIA = {"img", "video", "audio", "picture", "iframe", "object", "embed"}
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}
# Opening one of these closes an open paragraph, as HTML does.
CLOSES_PARAGRAPH = {
    "address", "article", "aside", "blockquote", "details", "div", "dl", "fieldset", "figure", "footer",
    "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "nav", "ol", "p", "pre", "section",
    "table", "ul",
}
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
        if tag in CLOSES_PARAGRAPH and self.stack[-1].tag == "p":
            self.stack.pop()
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


# Inline formatting a reader sees, written back as Markdown in heading text.
INLINE_MARKERS = {"em": "*", "i": "*", "strong": "**", "b": "**", "del": "~~", "s": "~~", "strike": "~~"}
# Inline HTML GitHub shows apart from plain text, written back as tags.
INLINE_TAGS = {"sub", "sup", "kbd", "mark", "ins", "u", "small", "abbr"}


def renderer_link(node: Node) -> bool:
    """A link GitHub adds, not the author: a heading anchor, or one to the image it wraps."""
    if "anchor" in node.attrs.get("class", "").split():
        return True
    children = elements(node.children)
    sources = {child.attrs.get(key) for child in children for key in ("src", "data-canonical-src")}
    own_text = "".join(child for child in node.children if isinstance(child, str)).strip()
    only_images = bool(children) and all(child.tag == "img" for child in children)
    return only_images and not own_text and node.attrs.get("href") in sources


def literal(text: str) -> str:
    """Text with each inline marker character escaped, as Markdown writes it literally."""
    return re.sub(r"([`*~<\[])", r"\\\1", text)


def heading_text(node: Node | str) -> str:
    """A heading's words, with its inline code in backticks.

    GitHub turns `:warning:` into an emoji in text but not in code, so a
    heading with the shortcode in code differs from one without, and a
    struck-out or emphasized word differs from plain text. A literal marker
    character reads escaped, as it is written, so it never passes for one.
    Inline code is written between backticks longer than any run inside it,
    so a reported heading can be pasted back as it is.
    """
    if isinstance(node, str):
        return literal(node)
    if node.tag == "img":
        return literal(node.attrs.get("alt", ""))
    if node.tag == "code":
        code = text_of(node)
        fence = "`" * (max((len(run) for run in re.findall(r"`+", code)), default=0) + 1)
        padded = code[:1] == "`" or code[-1:] == "`" or (code[:1] == code[-1:] == " " and code.strip())
        return f"{fence} {code} {fence}" if padded else f"{fence}{code}{fence}"
    inner = "".join(heading_text(child) for child in node.children)
    if node.tag == "a" and node.attrs.get("href") and not renderer_link(node):
        return f"[{inner}]({node.attrs['href']})"
    if node.tag in INLINE_TAGS:
        return f"<{node.tag}>{inner}</{node.tag}>"
    marker = INLINE_MARKERS.get(node.tag, "")
    return f"{marker}{inner}{marker}"


def words(node: Node | str) -> str:
    return " ".join(text_of(node).split())


def elements(nodes: list[Node | str]) -> list[Node]:
    return [node for node in nodes if isinstance(node, Node)]


def has_media(node: Node) -> bool:
    return any(child.tag in MEDIA or has_media(child) for child in elements(node.children))


def is_alert(node: Node) -> bool:
    return node.tag == "div" and "markdown-alert" in node.attrs.get("class", "").split()


def names_head(paragraph: Node) -> bool:
    """Whether a paragraph's first line opens with a plain `Edit:` and names a commit in code."""
    opening = paragraph.children[0] if paragraph.children else None
    if not isinstance(opening, str) or not opening.lstrip().startswith("Edit:"):
        return False

    def first_line(node: Node) -> bool | None:
        """True once a commit in code is found, False at the first line break."""
        for child in node.children:
            if isinstance(child, str):
                if "\n" in child:
                    return False
            elif child.tag == "code":
                if re.fullmatch(r"[0-9a-fA-F]{4,40}", words(child)):
                    return True
            else:
                found = first_line(child)
                if found is not None:
                    return found
        return None

    return bool(first_line(paragraph))


def is_footnotes(node: Node) -> bool:
    """The footnotes section GitHub appends, with its generated heading."""
    return node.tag == "section" and "data-footnotes" in node.attrs


def is_checked(node: Node) -> bool:
    """A checked task-list box; a hidden or other input shows no answer."""
    return node.tag == "input" and node.attrs.get("type") == "checkbox" and "checked" in node.attrs


def has_checked(node: Node) -> bool:
    return any(is_checked(child) or has_checked(child) for child in elements(node.children))


# The review note's rule in the source: `---` with a blank line before and after.
NOTE_SOURCE = re.compile(r"(?:\A|\n)[ \t]*\n[ \t]{0,3}(?:-[ \t]*){3,}\n[ \t]*\n[ \t]{0,3}Edit:")


def source_line(node: Node) -> int | None:
    """The source line the renderer marked a block with, if the mark is its own.

    Raw HTML keeps any `data-sourcepos` an author wrote, so only a well-formed
    mark is read; the caller checks the line it names.
    """
    position = re.fullmatch(r"([1-9][0-9]*):[0-9]+-[0-9]+:[0-9]+", node.attrs.get("data-sourcepos", ""))
    return int(position.group(1)) if position else None


def spaced_rule(rule: Node, note: Node, source: str | None, positioned: bool = False) -> bool:
    """Whether a rendered rule is a `---` line with a blank line before and after it, then the note.

    The local renderer marks each block with its source line; HTML without
    those marks, such as GitHub's, is checked against the source as a whole.
    """
    if source is None:
        return True
    source = source.replace("\r\n", "\n")
    if not positioned:
        # HTML with no positions at all, such as GitHub's, is checked against the source.
        return bool(NOTE_SOURCE.search(source))
    lines = source.split("\n")
    line, note_line = source_line(rule), source_line(note)
    # A raw <hr>, or one whose mark names another line, is no separator.
    if line is None or note_line is None or not line < note_line <= len(lines):
        return False
    before = lines[line - 2] if line >= 2 else ""
    between = lines[line : note_line - 1]
    return (
        bool(re.fullmatch(r" {0,3}(?:-[ \t]*){3,}", lines[line - 1]))
        and not before.strip()
        and bool(between)
        and not any(entry.strip() for entry in between)
        and lines[note_line - 1].lstrip().startswith("Edit:")
    )


class EndOfBody(Exception):
    """Reading reached the review note, where the body ends."""


def note_rule(children: list[Node | str], valid: Callable[[Node, Node], bool]) -> Node | None:
    """The rule that opens the last review note, also inside wrapper elements."""
    found = None
    blocks = elements(children)
    for index, block in enumerate(blocks):
        following = blocks[index + 1] if index + 1 < len(blocks) else None
        if block.tag == "hr" and following is not None and following.tag == "p" and names_head(following) and valid(block, following):
            found = block
        elif block.tag == "div" and not is_alert(block):
            found = note_rule(block.children, valid) or found  # Later in the document than any before it.
    return found


def headings(html: str, kind: str | None = None, source: str | None = None) -> list[Heading]:
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
    end = None
    if kind == "pr":
        # The review note closes the body: a `---` rule with a blank line
        # before and after it, then a line that opens with `Edit:` and names
        # the head it covers in code, such as ``Edit: `1a2b3c4` reviewed``.
        positioned = "data-sourcepos" in html
        end = note_rule(top, lambda rule, note: spaced_rule(rule, note, source, positioned))
    if kind == "issue" and blocks:
        last = blocks[-1]
        paragraphs = [node for node in elements(last.children) if "markdown-alert-title" not in node.attrs.get("class", "")]
        lines = [line.strip() for line in text_of(paragraphs[0]).splitlines() if line.strip()] if len(paragraphs) == 1 else []
        opening = paragraphs[0].children[0] if len(paragraphs) == 1 and paragraphs[0].children else None
        if last.tag == "blockquote" and isinstance(opening, str) and opening.strip().split("\n")[0] == "[!NOTE]":
            lines = lines[1:]  # cmark-gfm leaves the alert a quote that opens with its marker.
        elif "markdown-alert-note" not in last.attrs.get("class", "").split():
            lines = []
        if len(lines) == 1 and ATTRIBUTION.fullmatch(" ".join(lines[0].split())) and not has_media(last):
            top = [node for node in top if node is not last]

    found: list[Heading] = []
    open_sections: list[Heading] = []

    def content() -> None:
        for section in open_sections:
            section.has_content = True

    def visit(children: list[Node | str], nested: bool) -> None:
        for child in children:
            if child is end:
                raise EndOfBody
            if isinstance(child, str):
                if child.strip():
                    content()
                continue
            level = HEADING_TAG.fullmatch(child.tag)
            if level and not nested:
                position = child.attrs.get("data-sourcepos", "")
                line = int(position.split(":")[0]) if position[:1].isdigit() else None
                heading = Heading(int(level.group(1)), " ".join(heading_text(child).split()), line)
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

    try:
        visit(top, False)
    except EndOfBody:
        pass
    return found


def render(markdown: str) -> str:
    """Markdown as GitHub renders it in an issue or pull request, rendered locally.

    cmark-gfm renders raw HTML here, as GitHub does before it filters the
    tags it never shows; alerts stay quotes that open with their marker.
    """
    if not markdown.strip():
        return ""
    if cmarkgfm is not None:
        return cmarkgfm.github_flavored_markdown_to_html(
            markdown, options=Options.CMARK_OPT_UNSAFE | Options.CMARK_OPT_FOOTNOTES | Options.CMARK_OPT_SOURCEPOS
        )
    uv = shutil.which("uv")
    if not uv:
        raise CheckError(f"the Markdown renderer is not installed: pip install {CMARKGFM}")
    # Outside the checkout, with uv's configuration files ignored and PyPI named,
    # so no checkout can choose where the renderer comes from; Python runs
    # isolated (-I), so no file in that directory can stand in for it.
    command = [
        uv, "run", "--quiet", "--no-config", "--no-project", "--isolated",
        "--default-index", "https://pypi.org/simple", "--python", sys.executable,
        "--with", CMARKGFM, "python", "-I", "-c", RENDER,
    ]
    # Index settings inherited from the environment could still add or prefer another source.
    environment = {key: value for key, value in os.environ.items() if key not in UV_SOURCES}
    try:
        completed = subprocess.run(
            command, input=markdown, cwd=tempfile.gettempdir(), env=environment, text=True, encoding="utf-8",
            capture_output=True, timeout=300, check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise CheckError("the Markdown renderer did not start through uv within 300s") from error
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip()[-500:]
        raise CheckError(f"cannot run the Markdown renderer through uv ({detail}); pip install {CMARKGFM}")
    return completed.stdout


def front_matter(text: str) -> tuple[dict[str, str], str]:
    """Split a Markdown template's YAML front matter from its body."""
    lines = text.replace("\r\n", "\n").split("\n")
    if not lines or lines[0].strip() != "---":
        return {}, text
    for index, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            block = [entry for entry in lines[1:index] if entry.strip() and not re.match(r"\.\.\.(?:[ \t]+#.*)?[ \t]*$", entry)]
            # Front matter is a YAML mapping, in block or flow style, at any
            # indent; an opening `---` rule over Markdown is part of the body.
            joined = " ".join(entry.strip() for entry in block)
            if joined.startswith("{"):
                return flow_mapping(joined), "\n".join(lines[index + 1 :])
            if not any(YAML_KEY.match(entry.lstrip()) for entry in block):
                return {}, text
            margin = min(len(entry) - len(entry.lstrip()) for entry in block)
            fields = {}
            for entry in block:
                key, separator, value = entry.partition(":")
                if separator and len(entry) - len(entry.lstrip()) == margin:
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
        opened = value.strip()[:1]
        if opened in ("'", '"') and not re.match(r"""(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')""", value.strip()):
            return ""  # A quoted name continued on later lines is not read here: unknown.
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
    content = [line.strip() for line in lines if line.strip() and not line.lstrip().startswith("#")]
    if content[:1] == ["---"]:
        content = content[1:]  # A YAML document marker before the mapping.
    if content and content[0].startswith("{"):
        return flow_mapping(" ".join(content)).get("name", "")
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
    if not declared and re.search(r"""(?m)^["']?name["']?[ \t]*:""", text):
        # A name the form declares but this reader cannot read: it may be any template's.
        raise CheckError(f"{path}: cannot read the issue form's name; pass --template PATH")
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
            return (self.root / path).read_text(encoding="utf-8")
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
            if not declared:
                return True  # Every form declares a name; one not found here may be this one.
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


def gh_runner(args: list[str]) -> str | None:
    """Run gh and return its output, or None for a resource GitHub reports missing."""
    try:
        completed = subprocess.run(
            ["gh", *args], text=True, encoding="utf-8", capture_output=True, timeout=60, check=False,
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


def github_host(host: str) -> str:
    """A host as gh resolves it: www and SSH-over-443 aliases of github.com are github.com."""
    host = host.lower()
    return "github.com" if host in ("www.github.com", "ssh.github.com") else host


def repository(name: str | None) -> str | None:
    """OWNER/REPO or HOST/OWNER/REPO, also from a repository URL gh accepts."""
    if not name:
        return name
    if "://" not in name:
        parts = name.split("/")
        if len(parts) not in (2, 3) or not all(parts):
            raise CheckError(f"--repo {name} is not OWNER/REPO, HOST/OWNER/REPO or a repository URL")
        return "/".join([github_host(parts[0]), *parts[1:]]) if len(parts) == 3 else name
    url = urlparse(name)
    path = url.path.strip("/").removesuffix(".git")
    if not url.hostname or path.count("/") != 1:
        raise CheckError(f"--repo {name} names no repository")
    return f"{github_host(url.hostname)}/{path}"


def run(args: argparse.Namespace) -> dict[str, Any]:
    args.repo = repository(args.repo)
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
    kind = "pr" if args.pr is not None else "issue" if args.issue is not None else args.kind
    if args.template:
        try:
            templates = [parse_template(str(args.template), args.template.read_text(encoding="utf-8"))]
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
        templates = readable(discover(source, kind, None, args.template_name), args.template_name)
        absent = f"no {kind} template with headings found"
    templates = [template for template in templates if template.headings]
    if not templates:
        return {"state": "no-template", "body": source_label, "problems": [], "reason": absent}

    # Without a kind, as with --template alone, the body reads as a pull request's.
    text = text.removeprefix("\ufeff")
    body = headings(render(text), kind or "pr", text)
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
