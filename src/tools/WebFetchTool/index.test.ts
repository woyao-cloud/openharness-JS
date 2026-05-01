import assert from "node:assert/strict";
import { test } from "node:test";
import { WebFetchTool } from "./index.js";

test("WebFetchTool stamps outputType='json' when response Content-Type is application/json", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    const r = await WebFetchTool.call({ url: "https://example.com/api" }, { workingDir: process.cwd() });
    assert.equal(r.outputType, "json");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("WebFetchTool stamps outputType='markdown' when response Content-Type is text/markdown", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("# hello", { status: 200, headers: { "content-type": "text/markdown" } })) as typeof fetch;
  try {
    const r = await WebFetchTool.call({ url: "https://example.com/page.md" }, { workingDir: process.cwd() });
    assert.equal(r.outputType, "markdown");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("WebFetchTool stamps outputType='plain' when response Content-Type is text/html", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;
  try {
    const r = await WebFetchTool.call({ url: "https://example.com/page.html" }, { workingDir: process.cwd() });
    assert.equal(r.outputType, "plain");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("WebFetchTool stamps outputType='json' for structured JSON media types like application/vnd.api+json", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response('{"data":{"id":"1"}}', {
      status: 200,
      headers: { "content-type": "application/vnd.api+json" },
    })) as typeof fetch;
  try {
    const r = await WebFetchTool.call({ url: "https://example.com/api" }, { workingDir: process.cwd() });
    assert.equal(r.outputType, "json");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
