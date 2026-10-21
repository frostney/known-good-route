---
name: template-check
description: >-
  Compares an issue or pull request body's headings with the repository's
  template, used internally by issue and PR workflows. Use when another
  workflow must check a draft or posted body against its template.
license: Unlicense OR MIT
compatibility: >-
  Requires Python 3.11 or newer and git. Reading a live body or a remote
  repository's templates also requires the GitHub CLI (gh) authenticated to
  that repository, and network access.
---

# Template check

Run `scripts/check_template.py` to compare a body's headings with the template
it should follow. It reports each template heading that is missing, renamed,
out of order or left empty. The caller owns the rule the body must meet and
fixes the body; this skill only reports.

## Running a check

Run it as `python3 "$SKILL_DIR/scripts/check_template.py"`, where `SKILL_DIR`
is this skill's directory, from the checkout of the repository the body
belongs to.

- Check a draft with `--body FILE`, or `--body -` for standard input, plus
  `--kind issue` or `--kind pr`. Check a posted body with `--pr N` or
  `--issue N`.
- The template is discovered where GitHub looks for it, in the root, `docs/`
  and `.github/`: `pull_request_template.md` or a `PULL_REQUEST_TEMPLATE/`
  folder for PRs, and `issue_template.md` or an `ISSUE_TEMPLATE/` folder of
  templates and issue forms for issues. `--root` names another checkout.
  `--repo OWNER/REPO` names the repository for `--pr` and `--issue` and,
  without `--root`, reads the templates from its default branch.
- With several templates, pass the one the body follows with
  `--template-name`, matching its front matter `name` or its file name.
  Otherwise the closest fit is used. `--template PATH` skips discovery.
- `--json` prints one JSON object with the same result.

## Reading the result

- Exit 0 with `match`: every template heading is present, verbatim, in order
  and has content.
- Exit 0 with `no-template`: the repository has no template with headings, so
  there is nothing to compare.
- Exit 1 with `mismatch`: fix each reported heading in the body and run the
  check again.
- Exit 2 with `operational-error`: the check could not compare, for example
  outside a git checkout, for an unreachable repository, for an issue form it
  cannot read, or for a body that fits several templates equally. Fix the
  cause it names, pass `--repo`, `--template-name` or `--template PATH` as it
  says, and never treat it as a pass.

It reads Markdown headings in ATX form (`## Title`). Setext headings and
headings inside list items are not recognized. Reading stops at a pull
request's review note, a `---` rule after a blank line followed by an `Edit:`
line, so the note is not content of the last template section.
