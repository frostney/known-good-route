---
name: template-check
description: >-
  Compares an issue or pull request body's headings with the repository's
  template, used internally by issue and PR workflows. Use when another
  workflow must check a draft or posted body against its template.
license: Unlicense OR MIT
compatibility: >-
  Requires Python 3.11 or newer, git, network access and the GitHub CLI (gh)
  authenticated to GitHub, which renders every Markdown body and template.
  Reading a live body or a remote repository's templates also needs access to
  that repository.
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
  `--repo OWNER/REPO`, `HOST/OWNER/REPO` or the repository's URL names the
  repository for `--pr` and `--issue` and, without `--root`, reads the
  templates from its default branch.
- With several templates, pass the one the body follows with
  `--template-name`, matching its front matter `name` or its file name.
  Without it the closest fit is used, and a tie is an error. Choose it from
  what the body is for, such as the issue's or PR's labels or title, and ask
  only when nothing settles it. `--template PATH` skips discovery.
- `--json` prints one JSON object with the same result.

## Reading the result

- Exit 0 with `match`: every template heading is present, verbatim, in order
  and has content.
- Exit 0 with `no-template`: the repository has no template with headings, so
  there is nothing to compare.
- Exit 1 with `mismatch`: fix each reported heading in the body and run the
  check again.
- Exit 2 with `operational-error`: the check could not compare, for example
  outside a git checkout, when GitHub cannot render the Markdown, for an
  unreachable repository, for an issue form it cannot read, or for a body that
  fits several templates equally. Fix the
  cause it names, pass `--repo`, `--template-name` or `--template PATH` as it
  says, and never treat it as a pass.

It reads a Markdown body or template as GitHub renders it, through the
Markdown API of the repository's own GitHub host, so a heading counts exactly
where GitHub shows one. The body renders on the host of the repository it
belongs to: a host-qualified `--repo` or `GH_REPO`, then `GH_HOST`, then the
repository gh resolves for the current checkout. A template found in a
checkout, the current one or `--root`, renders on the host of that checkout's
own repository, whatever `--repo`, `GH_REPO` or `GH_HOST` name. A checkout
whose host cannot be resolved is an operational error, never a render on
another host. A host is resolved, and Markdown rendered, only when there is
something to compare. With `--template-name`, only the templates that can be
the one named are rendered. Text in code,
comments and other HTML GitHub does not show is no heading. A heading inside a
list item, quote, table or alert is its section's content, not a section of
its own. A template heading pairs with a body heading at the same level before
one at another level, so a subsection that shares a section's name does not
stand in for it. A list item that shows nothing, or only `[ ]`, such as a
template's `-` placeholder, is not content. Reading stops at a pull request's
review note, the last rule followed by `Edit:` and the head it covers in code,
such as ``Edit: `1a2b3c4` reviewed``, so the note is not content of the last
template section. For an issue, the
attribution note `create-issue` closes it with is not content either.

Issue forms are YAML that GitHub does not render here, so the check reads them
itself: in GitHub's block layout, where a field's `attributes` may be a
one-line flow mapping. A form written in any other flow style is an
operational error, never a partial check.
