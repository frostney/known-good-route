import type { RemoteIssue } from "./issue-receipt.ts";

export function issuePage(issues: RemoteIssue[], marker: string, page: number) {
  if (!Number.isSafeInteger(page) || page < 1)
    throw new Error("Invalid discovery page");
  const ordered = [...issues].sort((a, b) => a.number - b.number);
  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(ordered.length / pageSize));
  if (page > totalPages)
    throw new Error(`Page exceeds ${totalPages} available pages`);
  return {
    total: ordered.length,
    page,
    totalPages,
    nextPage: page < totalPages ? page + 1 : null,
    matchingOperationNumbers: ordered
      .filter((i) => !i.pull_request && (i.body ?? "").includes(marker))
      .map((i) => i.number),
    issues: ordered.slice((page - 1) * pageSize, page * pageSize).map((i) => ({
      number: i.number,
      url: i.html_url,
      title: i.title.slice(0, 300),
      titleTruncated: i.title.length > 300,
      bodyPreview: (i.body ?? "").slice(0, 240),
      bodyLength: (i.body ?? "").length,
      bodyTruncated: (i.body ?? "").length > 240,
      pullRequest: Boolean(i.pull_request),
    })),
  };
}

export function issueBodyChunk(issue: RemoteIssue, offset: number) {
  const body = issue.body ?? "";
  const splitsPair = (n: number) =>
    n > 0 &&
    body.charCodeAt(n - 1) >= 0xd800 &&
    body.charCodeAt(n - 1) <= 0xdbff &&
    body.charCodeAt(n) >= 0xdc00 &&
    body.charCodeAt(n) <= 0xdfff;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > body.length)
    throw new Error("Invalid issue body offset");
  if (splitsPair(offset))
    throw new Error(
      "Offset splits a Unicode character; use the returned nextOffset",
    );
  let end = Math.min(body.length, offset + 4000);
  if (splitsPair(end)) end--;
  return {
    number: issue.number,
    url: issue.html_url,
    title: issue.title,
    body: body.slice(offset, end),
    offset,
    totalCharacters: body.length,
    nextOffset: end < body.length ? end : null,
  };
}
