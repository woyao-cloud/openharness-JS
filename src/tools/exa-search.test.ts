import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { buildRequestBody, ExaSearchTool, extractSnippet, formatResults } from "./ExaSearchTool/index.js";

const ctx = { workingDir: process.cwd() };
const originalFetch = globalThis.fetch;
const originalKey = process.env.EXA_API_KEY;

function restore() {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) {
    delete process.env.EXA_API_KEY;
  } else {
    process.env.EXA_API_KEY = originalKey;
  }
}

test("returns error when EXA_API_KEY is unset", async () => {
  delete process.env.EXA_API_KEY;
  const r = await ExaSearchTool.call({ query: "anything" }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.output, /EXA_API_KEY/);
  restore();
});

test("buildRequestBody includes camelCase fields and default content modes", () => {
  const body = buildRequestBody({
    query: "ai agents",
    num_results: 7,
    type: "neural",
    category: "research paper",
    include_domains: ["arxiv.org"],
    exclude_domains: ["spam.com"],
    include_text: ["agent"],
    exclude_text: ["deprecated"],
    start_published_date: "2024-01-01",
    end_published_date: "2026-01-01",
    user_location: "US",
  });
  assert.equal(body.query, "ai agents");
  assert.equal(body.numResults, 7);
  assert.equal(body.type, "neural");
  assert.equal(body.category, "research paper");
  assert.deepEqual(body.includeDomains, ["arxiv.org"]);
  assert.deepEqual(body.excludeDomains, ["spam.com"]);
  assert.deepEqual(body.includeText, ["agent"]);
  assert.deepEqual(body.excludeText, ["deprecated"]);
  assert.equal(body.startPublishedDate, "2024-01-01");
  assert.equal(body.endPublishedDate, "2026-01-01");
  assert.equal(body.userLocation, "US");
  assert.ok(body.contents);
  assert.deepEqual(body.contents?.text, { maxCharacters: 1500 });
  assert.equal(body.contents?.highlights, true);
  assert.equal(body.contents?.summary, undefined);
});

test("buildRequestBody honors content opt-outs and summary_query", () => {
  const body = buildRequestBody({
    query: "q",
    text: false,
    highlights: false,
    summary: true,
    summary_query: "tldr",
  });
  assert.equal(body.contents?.text, undefined);
  assert.equal(body.contents?.highlights, undefined);
  assert.deepEqual(body.contents?.summary, { query: "tldr" });
});

test("buildRequestBody summary=true without summary_query is boolean", () => {
  const body = buildRequestBody({
    query: "q",
    text: false,
    highlights: false,
    summary: true,
  });
  assert.equal(body.contents?.summary, true);
});

test("extractSnippet prefers highlights, then summary, then text", () => {
  assert.equal(extractSnippet({ url: "x", highlights: ["a", "b"], summary: "s", text: "t" }), "a … b");
  assert.equal(extractSnippet({ url: "x", summary: "s", text: "t" }), "s");
  assert.equal(extractSnippet({ url: "x", text: "long text here" }), "long text here");
  assert.equal(extractSnippet({ url: "x" }), "");
});

test("extractSnippet truncates long text", () => {
  const long = "a".repeat(500);
  const snippet = extractSnippet({ url: "x", text: long });
  assert.ok(snippet.length <= 301);
  assert.ok(snippet.endsWith("…"));
});

test("formatResults renders title, url, meta, snippet", () => {
  const out = formatResults({
    results: [
      {
        url: "https://example.com/a",
        title: "Article A",
        author: "Alice",
        publishedDate: "2025-06-01T00:00:00Z",
        highlights: ["key insight"],
      },
    ],
  });
  assert.match(out, /1\. Article A/);
  assert.match(out, /https:\/\/example\.com\/a/);
  assert.match(out, /by Alice/);
  assert.match(out, /2025-06-01/);
  assert.match(out, /key insight/);
});

test("formatResults handles empty results", () => {
  assert.equal(formatResults({ results: [] }), "No results found.");
});

test("ExaSearch.call sends correct headers and body, parses response", async () => {
  process.env.EXA_API_KEY = "test-key-123";
  let captured: { url: string; init: RequestInit } | null = null;
  globalThis.fetch = mock.fn(async (url: any, init: any) => {
    captured = { url: String(url), init };
    return new Response(
      JSON.stringify({
        results: [{ url: "https://exa.ai/post", title: "Hello", highlights: ["snippet"] }],
      }),
      { status: 200 },
    );
  }) as any;

  const r = await ExaSearchTool.call({ query: "test" }, ctx);
  assert.equal(r.isError, false);
  assert.match(r.output, /Hello/);
  assert.match(r.output, /snippet/);

  assert.ok(captured);
  const c = captured as unknown as { url: string; init: RequestInit };
  assert.equal(c.url, "https://api.exa.ai/search");
  assert.equal((c.init as any).method, "POST");
  const headers = c.init.headers as Record<string, string>;
  assert.equal(headers["x-api-key"], "test-key-123");
  assert.equal(headers["x-exa-integration"], "openharness");
  const body = JSON.parse(c.init.body as string);
  assert.equal(body.query, "test");

  restore();
});

test("ExaSearch.call surfaces API errors", async () => {
  process.env.EXA_API_KEY = "k";
  globalThis.fetch = mock.fn(
    async () => new Response("rate limit", { status: 429, statusText: "Too Many Requests" }),
  ) as any;
  const r = await ExaSearchTool.call({ query: "test" }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.output, /429/);
  restore();
});

test("ExaSearch.call handles network errors", async () => {
  process.env.EXA_API_KEY = "k";
  globalThis.fetch = mock.fn(async () => {
    throw new Error("ECONNREFUSED");
  }) as any;
  const r = await ExaSearchTool.call({ query: "test" }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.output, /ECONNREFUSED/);
  restore();
});

test("ExaSearch tool metadata", () => {
  assert.equal(ExaSearchTool.name, "ExaSearch");
  assert.equal(ExaSearchTool.riskLevel, "medium");
  assert.equal(ExaSearchTool.isReadOnly({ query: "q" }), true);
  assert.equal(ExaSearchTool.isConcurrencySafe({ query: "q" }), true);
  assert.match(ExaSearchTool.prompt(), /EXA_API_KEY/);
});
