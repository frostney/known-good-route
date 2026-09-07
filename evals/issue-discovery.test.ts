import { expect, test } from "bun:test";
import { issuePage, issueBodyChunk } from "./issue-discovery.ts";
const issues = Array.from({ length: 31 }, (_, n) => ({
  number: n + 1,
  html_url: `https://github.com/test/repo/issues/${n + 1}`,
  title: "Issue",
  body: "x".repeat(20000),
  user: { login: "test" },
}));
test("discovery bounds model output and finds an operation beyond the current page", () => {
  const input = structuredClone(issues).reverse();
  input[0]!.body += "<!-- match -->";
  const first = issuePage(input, "<!-- match -->", 1);
  expect(first.matchingOperationNumbers).toEqual([31]);
  expect(first.nextPage).toBe(2);
  expect(JSON.stringify(first).length).toBeLessThan(7000);
  const pages = [1, 2, 3, 4].flatMap(
    (page) => issuePage(input, "<!-- match -->", page).issues,
  );
  expect(pages.map((i) => i.number)).toEqual(issues.map((i) => i.number));
  expect(issuePage(input, "<!-- match -->", 4).nextPage).toBeNull();
  expect(() => issuePage(input, "<!-- match -->", 5)).toThrow();
  expect(() => issuePage(input, "<!-- match -->", 0)).toThrow();
});
test("chunked candidate reading retains exact content and exposes continuation", () => {
  const issue = {
    ...issues[0]!,
    body: "prefix" + "😀".repeat(6000) + "suffix",
  };
  let offset: number | null = 0;
  let reconstructed = "";
  while (offset !== null) {
    const chunk = issueBodyChunk(issue, offset);
    expect(chunk.body.length).toBeLessThanOrEqual(4000);
    reconstructed += chunk.body;
    offset = chunk.nextOffset;
  }
  expect(reconstructed).toBe(issue.body);
  expect(() => issueBodyChunk(issue, issue.body.length + 1)).toThrow();
});

test("chunk boundaries do not expose half of a Unicode character to the native client", () => {
  const issue = { ...issues[0]!, body: "x".repeat(3999) + "😀tail" };
  const first = issueBodyChunk(issue, 0);
  expect(first.body).toBe("x".repeat(3999));
  expect(first.nextOffset).toBe(3999);
  expect(issueBodyChunk(issue, first.nextOffset!).body).toBe("😀tail");
  expect(() => issueBodyChunk(issue, 4000)).toThrow("Unicode");
});
