#!/usr/bin/env python3
"""Rewrite private GitHub references out of content bound for a public repository.

Standard library only. Exits 0 after rewriting (or finding nothing to rewrite)
and 2 when Git or GitHub cannot answer a question the guard depends on. The
destination repository can keep more JSON free-text lines by listing regular
expressions in .github/publication-guard.json as {"keep": ["^Ticket:"]}.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

sys.dont_write_bytecode = True  # Keep installed skill trees free of __pycache__.

PLACEHOLDER_OWNER = "example-org"
KEEP_CONFIG = ".github/publication-guard.json"
STATE_FILE = "kgr-publication-guard.json"
STUB = "[redacted]"
OWNER = r"[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}"
REPO = r"[A-Za-z0-9._-]*[A-Za-z0-9_-]"
REFERENCE = re.compile(
    rf"(?P<url>(?<![\w.-])(?P<scheme>(?:https?://)?(?:www\.)?)github\.com/(?P<uo>{OWNER})/(?P<ur>{REPO})"
    rf"(?P<tail>/[^\s)\]>\"'`]*)?)"
    rf"|(?P<hash>(?<![\w./@:#-])(?P<ho>{OWNER})/(?P<hr>{REPO})#(?P<hn>\d+)\b)"
    rf"|(?P<bare>(?<![\w./@:#-])(?P<bo>{OWNER})/(?P<br>{REPO})(?![\w/#-]|\.\w))"
)
MARKDOWN_LINK = re.compile(r"\[[^\]\n]*\]\(\s*<?((?:https?://)?(?:www\.)?github\.com/[^\s)>]+)>?(?:\s+\"[^\"]*\")?\s*\)")
TAIL_NUMBER = re.compile(r"^/(pull|pulls|issues)/(\d+)")
SHA = re.compile(r"(?<![0-9A-Za-z_-])[0-9a-f]{7,64}(?![0-9A-Za-z_-])")
PR_KEY = re.compile(r"^(?:prs?|pulls?|pull_?requests?(?:_?number)?|pr_?numbers?|number|issues?(?:_?number)?)$", re.I)
NOT_REPOSITORY_OWNERS = {
    "about", "account", "apps", "codespaces", "collections", "contact", "customer-stories", "dashboard",
    "enterprise", "explore", "features", "issues", "login", "marketplace", "new", "notifications", "orgs",
    "organizations", "pricing", "pulls", "readme", "search", "security", "settings", "site", "sponsors",
    "topics", "trending", "users",
}
STATUS = r"pass(?:ed|ing)?|fail(?:ed|ing|ure)?|ok|error|success(?:ful)?|pending|skipped|cancell?ed|timed[ -]out|neutral|queued|in[ _-]progress|completed|blocked|merged|closed|open"
DEFAULT_KEEP = (
    r"^\s*(?:>\s*)?(?:\*\*[^*\n]{1,80}:\*\*|<!--.*-->|\[![A-Z]+\])",
    rf"^\s*(?:[-*+]\s+)?(?:\[[ x]\]\s+)?(?:✅|❌|⚠️|(?:{STATUS})\b)",
    rf"^\s*[\w .-]{{1,40}}:\s*(?:{STATUS})\s*\.?\s*$",
    r"\b\d+(?:[.,]\d+)?\s?(?:%|ms|s|secs?|seconds?|mins?|minutes?|h|hrs?|hours?|days?|weeks?|months?|[kmgt]i?b|bytes?|tokens?|lines?|files?|commits?|tests?|reviews?|requests?|runs?|jobs?|checks?)(?!\w)",
    r"\b\d+(?:[.,]\d+)?\s?(?:per|/)\s?(?:hour|minute|second|day|h|min|s)\b",
)


class GuardError(RuntimeError):
    pass


def run(args, *, data=None, cwd=None, check=True):
    try:
        result = subprocess.run(args, input=data, cwd=cwd, capture_output=True)
    except FileNotFoundError as error:
        raise GuardError(f"{args[0]} is not installed or not on PATH") from error
    if check and result.returncode:
        raise GuardError(f"{' '.join(args[:3])} failed: {result.stderr.decode(errors='replace').strip()}")
    return result


def git(*args, data=None, cwd=None):
    return run(["git", *args], data=data, cwd=cwd).stdout


def slug_of(match):
    kind = next(k for k in ("url", "hash", "bare") if match.group(k))
    owner, repo = {"url": ("uo", "ur"), "hash": ("ho", "hr"), "bare": ("bo", "br")}[kind]
    repo_name = match.group(repo)
    if kind == "url" and repo_name.endswith(".git"):
        repo_name = repo_name[:-4]
    return kind, f"{match.group(owner)}/{repo_name}"


class Resolver:
    """Answers, through `gh api` as the current user, which slugs are private."""

    def __init__(self, destination):
        self.cache = {destination.lower(): "public"}
        self.owners = None
        self.calls = 0

    def lookup(self, slug):
        key = slug.lower()
        if key not in self.cache:
            self.calls += 1
            result = run(["gh", "api", f"repos/{slug}"], check=False)
            if result.returncode == 0:
                try:
                    body = json.loads(result.stdout)
                    public = body.get("visibility", "private" if body.get("private", True) else "public") == "public"
                    self.cache[key] = "public" if public else "private"
                except (ValueError, AttributeError):
                    self.cache[key] = "error"
            else:
                self.cache[key] = "missing" if b"HTTP 404" in result.stderr else "error"
        return self.cache[key]

    def own_owners(self):
        if self.owners is None:
            login = run(["gh", "api", "user", "--jq", ".login"], check=False).stdout.decode().split()
            orgs = run(["gh", "api", "--paginate", "user/orgs", "--jq", ".[].login"], check=False).stdout.decode().split()
            self.owners = {name.lower() for name in login + orgs}
        return self.owners

    def is_private(self, slug, forms):
        state = self.lookup(slug)
        if state == "missing" and forms == {"bare"}:
            # A bare word pair such as and/or is not a repository reference unless
            # its owner is the current user or one of their organizations.
            return slug.split("/")[0].lower() in self.own_owners()
        return state != "public"


class Mapper:
    """Stable placeholders, persisted under the Git directory so later runs agree."""

    def __init__(self, path):
        self.path = path
        self.state = {"repos": {}, "numbers": {}, "shas": {}}
        if path and path.is_file():
            try:
                self.state.update(json.loads(path.read_text(encoding="utf-8")))
            except ValueError:
                pass

    def repo(self, slug):
        repos = self.state["repos"]
        return repos.setdefault(slug.lower(), f"{PLACEHOLDER_OWNER}/example-repo-{len(repos) + 1}")

    def number(self, slug, value):
        numbers = self.state["numbers"].setdefault(slug.lower(), {})
        return numbers.setdefault(str(value), len(numbers) + 1)

    def sha(self, value):
        shas = self.state["shas"]
        if value not in shas:
            fresh = hashlib.sha256(f"example-sha-{len(shas) + 1}".encode()).hexdigest()
            prefix = next((shas[k] for k in shas if value.startswith(k)), "")
            longer = next((shas[k] for k in shas if k.startswith(value)), None)
            shas[value] = longer[:len(value)] if longer else (prefix + fresh[len(prefix):])[:len(value)]
        return shas[value]

    def save(self):
        if self.path and any(self.state.values()):
            temporary = self.path.with_name(self.path.name + ".tmp")
            temporary.write_text(json.dumps(self.state, indent=1, sort_keys=True), encoding="utf-8")
            os.replace(temporary, self.path)


class Sanitiser:
    def __init__(self, private, mapper, keep):
        self.private = private
        self.mapper = mapper
        self.keep = keep
        self.counts = {}
        self.placeholders = set()

    def bump(self, name, amount=1):
        self.counts[name] = self.counts.get(name, 0) + amount

    def private_slug(self, match):
        kind, slug = slug_of(match)
        return slug if slug.lower() in self.private else None

    def neutral(self, match):
        kind, _ = slug_of(match)
        if kind == "hash":
            return "an issue or pull request in a private repository"
        tail = (match.group("tail") or "") if kind == "url" else ""
        section = tail.split("/")[1] if tail.count("/") >= 2 else ""
        return {"pull": "a pull request in a private repository", "pulls": "a pull request in a private repository",
                "issues": "an issue in a private repository", "commit": "a commit in a private repository",
                "commits": "a commit in a private repository"}.get(section, "a private repository")

    def prose(self, text):
        def link(match):
            inner = REFERENCE.match(match.group(1))
            if inner and self.private_slug(inner):
                self.bump("references")
                return self.neutral(inner)
            return match.group(0)

        def reference(match):
            if not self.private_slug(match):
                return match.group(0)
            trailing = ""
            if match.group("tail"):
                stripped = match.group("tail").rstrip(".,;:!?")
                trailing = match.group("tail")[len(stripped):]
            self.bump("references")
            return self.neutral(match) + trailing

        return REFERENCE.sub(reference, MARKDOWN_LINK.sub(link, text))

    def data_string(self, text):
        def sha(match):
            value = match.group(0)
            if not (re.search(r"\d", value) and re.search(r"[a-f]", value)):
                return value
            self.bump("shas")
            return self.mapper.sha(value)

        def reference(match):
            private = self.private_slug(match)
            if not private:
                return match.group(0)
            self.bump("references")
            kind, _ = slug_of(match)
            placeholder = self.mapper.repo(private)
            self.placeholders.add(placeholder)
            if kind == "hash":
                self.bump("numbers")
                return f"{placeholder}#{self.mapper.number(private, int(match.group('hn')))}"
            if kind == "bare":
                return placeholder
            tail = match.group("tail") or ""
            numbered = TAIL_NUMBER.match(tail)
            if numbered:
                self.bump("numbers")
                tail = f"/{numbered.group(1)}/{self.mapper.number(private, int(numbered.group(2)))}" + tail[numbered.end():]
            return f"{match.group('scheme')}github.com/{placeholder}{tail}"

        text = REFERENCE.sub(reference, SHA.sub(sha, text))
        if ("\n" in text or len(text) >= 40) and re.search(r"\s", text.strip()):
            lines = text.split("\n")
            kept = [line if not line.strip() or any(p.search(line) for p in self.keep) else STUB for line in lines]
            self.bump("stubbedLines", sum(1 for old, new in zip(lines, kept) if old != new))
            text = "\n".join(kept)
        return text

    def own_slug(self, values):
        for value in values:
            if isinstance(value, str):
                for match in REFERENCE.finditer(value):
                    found = self.private_slug(match)
                    if found:
                        return found
        return None

    def walk(self, node, slug=None, key=None):
        if isinstance(node, dict):
            slug = self.own_slug(node.values()) or slug
            return {k: self.walk(v, slug, k) for k, v in node.items()}
        if isinstance(node, list):
            slug = self.own_slug(node) or slug
            return [self.walk(v, slug, key) for v in node]
        if slug is None or isinstance(node, bool):
            return node
        if isinstance(node, int) and key is not None and PR_KEY.match(key):
            self.bump("numbers")
            return self.mapper.number(slug, node)
        if isinstance(node, str):
            return self.data_string(node)
        return node

    def document(self, path, text):
        if path.lower().endswith(".json"):
            try:
                original = json.loads(text)
            except ValueError:
                return self.prose(text)
            if self.own_slug([text]):
                # Register full SHAs first so abbreviations map to their prefixes.
                for full in SHA.findall(text):
                    if len(full) in (40, 64):
                        self.mapper.sha(full)
            rewritten = self.walk(original)
            if rewritten == original:
                return text
            indent = re.search(r"^[\[{][ \t]*\n([ \t]+)", text)
            dumped = json.dumps(rewritten, ensure_ascii=False, indent=indent.group(1) if indent else None)
            return dumped + ("\n" if text.endswith("\n") else "")
        return self.prose(text)


def added_lines(diff):
    lines, in_hunk = [], False
    for line in diff.decode("utf-8", errors="replace").split("\n"):
        if line.startswith("@@"):
            in_hunk = True
        elif line.startswith("diff --git"):
            in_hunk = False
        elif in_hunk and line.startswith("+"):
            lines.append(line[1:])
    return lines


def changed_paths(root, spec):
    out = git("diff", "--numstat", "-z", "--no-renames", *spec, cwd=root).decode("utf-8", errors="replace")
    paths = []
    for record in out.split("\0"):
        parts = record.split("\t", 2)
        if len(parts) == 3 and parts[0] != "-" and parts[0] != "0":
            paths.append(parts[2])
    return paths


def candidates(texts, root, base_dir=""):
    found = {}
    for text in texts:
        for match in REFERENCE.finditer(text):
            kind, slug = slug_of(match)
            owner, repo = slug.split("/")
            if owner.lower() == PLACEHOLDER_OWNER:
                continue
            if kind == "url" and owner.lower() in NOT_REPOSITORY_OWNERS:
                continue
            if kind == "bare" and (owner.isdigit() or repo.isdigit() or (root / slug).exists()
                                   or (root / base_dir / slug).exists()):
                continue
            found.setdefault(slug, set()).add(kind)
    return found


def load_keep(root, warnings):
    patterns = list(DEFAULT_KEEP)
    config = root / KEEP_CONFIG
    if config.is_file():
        try:
            extra = json.loads(config.read_text(encoding="utf-8")).get("keep", [])
            patterns += [p for p in extra if isinstance(p, str)]
        except (ValueError, AttributeError):
            warnings.append(f"{KEEP_CONFIG} is not valid JSON; using the default keep list")
    compiled = []
    for pattern in patterns:
        try:
            compiled.append(re.compile(pattern, re.I))
        except re.error:
            warnings.append(f"skipped invalid keep pattern {pattern!r}")
    return compiled


def repository_root():
    result = run(["git", "rev-parse", "--show-toplevel", "--git-common-dir"], check=False)
    if result.returncode:
        return Path.cwd(), None
    top, common = result.stdout.decode().strip().split("\n")
    return Path(top), (Path(top) / common).resolve() / STATE_FILE


def destination_visibility(repo):
    if not repo:
        result = run(["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], check=False)
        repo = result.stdout.decode().strip()
        if result.returncode or not repo:
            raise GuardError("cannot determine the destination repository; pass --repo OWNER/REPO")
    result = run(["gh", "api", f"repos/{repo}", "--jq", ".visibility"], check=False)
    if result.returncode:
        raise GuardError(f"cannot ask GitHub whether {repo} is public: {result.stderr.decode(errors='replace').strip()}")
    return repo, result.stdout.decode().strip()


def rewrite_index(root, path, sanitiser):
    staged = run(["git", "cat-file", "blob", f":{path}"], cwd=root, check=False)
    entry = git("ls-files", "-s", "-z", "--", path, cwd=root).decode().split("\0")[0]
    if staged.returncode or not entry:
        return False
    try:
        original = staged.stdout.decode("utf-8")
    except UnicodeDecodeError:
        return False
    rewritten = sanitiser.document(path, original)
    if rewritten != original:
        blob = git("hash-object", "-w", "--stdin", "--path", path, data=rewritten.encode(), cwd=root).decode().strip()
        git("update-index", "--cacheinfo", f"{entry.split()[0]},{blob},{path}", cwd=root)
    worktree = root / path
    if worktree.is_file() and not worktree.is_symlink():
        try:
            current = worktree.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            return rewritten != original
        updated = rewritten if current == original else sanitiser.document(path, current)
        if updated != current:
            worktree.write_text(updated, encoding="utf-8")
    return rewritten != original


def guard(args):
    destination, visibility = destination_visibility(args.repo)
    report = {"destination": destination, "public": visibility == "public", "rewritten": [], "warnings": []}
    if visibility != "public":
        return report
    root, state_path = repository_root()
    texts, files, outgoing = {}, [], args.operation == "outgoing"
    if args.operation in {"staged", "outgoing"}:
        spec = ["--cached"] if args.operation == "staged" else [f"{args.base}...HEAD"]
        for path in changed_paths(root, spec):
            diff = git("diff", "--unified=0", "--no-color", "--no-ext-diff", "--no-renames", *spec, "--", path, cwd=root)
            files.append((path, added_lines(diff)))
    for name in ("message_file", "title_file", "body_file"):
        if getattr(args, name, None):
            texts[name] = Path(getattr(args, name)).read_text(encoding="utf-8")
    found = {}
    for path, lines in files:
        for slug, forms in candidates(lines, root, str(Path(path).parent)).items():
            found.setdefault(slug, set()).update(forms)
    for slug, forms in candidates(texts.values(), root).items():
        found.setdefault(slug, set()).update(forms)
    resolver = Resolver(destination)
    private = {slug.lower() for slug, forms in found.items() if resolver.is_private(slug, forms)}
    if not private:
        return report
    mapper = Mapper(state_path)
    keep = load_keep(root, report["warnings"])
    placeholders = set()
    for path, _ in files:
        sanitiser = Sanitiser(private, mapper, keep)
        if rewrite_index(root, path, sanitiser):
            report["rewritten"].append({"target": path, "staged": True, **sanitiser.counts})
            placeholders |= sanitiser.placeholders
    labels = {"message_file": "commit message", "title_file": "PR title", "body_file": "PR body"}
    for name, text in texts.items():
        sanitiser = Sanitiser(private, mapper, keep)
        rewritten = sanitiser.prose(text)
        if rewritten != text:
            Path(getattr(args, name)).write_text(rewritten, encoding="utf-8")
            report["rewritten"].append({"target": labels[name], **sanitiser.counts})
    mapper.save()
    report["placeholders"] = sorted(placeholders)
    if outgoing and report["rewritten"]:
        report["warnings"].append("earlier commits on the branch still contain the original references")
    return report


def render(report):
    if not report["public"]:
        return f"publication guard: {report['destination']} is not public; nothing checked"
    lines = [f"publication guard: {report['destination']} is public"]
    if not report["rewritten"]:
        lines.append("nothing to rewrite")
    for row in report["rewritten"]:
        details = ", ".join(f"{label} {row[k]}" for k, label in (
            ("references", "references"), ("numbers", "PR numbers"), ("shas", "SHAs"), ("stubbedLines", "stubbed lines"))
            if row.get(k))
        lines.append(f"rewrote {row['target']}{' (staged)' if row.get('staged') else ''}: {details}")
    lines += [f"placeholder {name} stands for a private repository" for name in report.get("placeholders", [])]
    lines += [f"warning: {warning}" for warning in report["warnings"]]
    return "\n".join(lines)


def main(argv=None):
    if sys.version_info < (3, 11):
        raise GuardError("Python 3.11 or newer is required")
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="operation", required=True)
    staged = commands.add_parser("staged", help="rewrite the staged diff and, optionally, the commit message file")
    staged.add_argument("--message-file")
    outgoing = commands.add_parser("outgoing", help="rewrite and stage files the branch changes since BASE")
    outgoing.add_argument("--base", required=True)
    pr = commands.add_parser("pr", help="rewrite PR title and body files in place")
    pr.add_argument("--title-file")
    pr.add_argument("--body-file")
    for command in (staged, outgoing, pr):
        command.add_argument("--repo", help="destination OWNER/REPO; defaults to the current gh repository")
        command.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    report = guard(args)
    print(json.dumps(report) if args.json else render(report))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except GuardError as error:
        print("Error: publication guard: " + str(error), file=sys.stderr)
        sys.exit(2)
