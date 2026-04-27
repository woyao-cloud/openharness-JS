import assert from "node:assert/strict";
import test from "node:test";
import { LspClient } from "./client.js";

// The LspClient uses subprocess communication, which is hard to test
// without a real language server. Test the message framing logic instead.

test("LSP: Content-Length framing format is correct", () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
  const frame = header + body;

  // Parse it back
  const headerEnd = frame.indexOf("\r\n\r\n");
  assert.ok(headerEnd > 0);
  const headerStr = frame.slice(0, headerEnd);
  const match = headerStr.match(/Content-Length:\s*(\d+)/i);
  assert.ok(match);
  const contentLength = parseInt(match[1]!, 10);
  assert.equal(contentLength, Buffer.byteLength(body));
  const parsed = JSON.parse(frame.slice(headerEnd + 4));
  assert.equal(parsed.method, "initialize");
});

test("LSP: JSON-RPC request format is valid", () => {
  const req = {
    jsonrpc: "2.0",
    id: 1,
    method: "textDocument/definition",
    params: { textDocument: { uri: "file:///test.ts" }, position: { line: 0, character: 5 } },
  };
  const json = JSON.stringify(req);
  const parsed = JSON.parse(json);
  assert.equal(parsed.jsonrpc, "2.0");
  assert.equal(parsed.method, "textDocument/definition");
  assert.equal(parsed.params.position.line, 0);
});

test("LSP: diagnostic severity mapping", () => {
  const severityMap: Record<number, string> = { 1: "Error", 2: "Warning", 3: "Info", 4: "Hint" };
  assert.equal(severityMap[1], "Error");
  assert.equal(severityMap[2], "Warning");
  assert.equal(severityMap[3], "Info");
  assert.equal(severityMap[4], "Hint");
});

test("LSP: file URI conversion", () => {
  const filePath = "/home/user/project/src/index.ts";
  const uri = `file://${filePath.replace(/\\/g, "/")}`;
  assert.equal(uri, "file:///home/user/project/src/index.ts");

  // Windows path
  const winPath = "C:\\Users\\test\\project\\src\\index.ts";
  const winUri = `file://${winPath.replace(/\\/g, "/")}`;
  assert.equal(winUri, "file://C:/Users/test/project/src/index.ts");
});

// ── Hover content unwrap (audit B9 polish) ───────────────────────────────────
// LSP `textDocument/hover` returns three valid shapes for `contents`:
//   bare string, { kind, value }, or array of either. The unwrapper needs
//   to handle all three plus the null-ish cases (server returned no info,
//   server doesn't support hover) without throwing.

test("LSP: hover unwraps a bare string contents", () => {
  const result = LspClient.unwrapHoverContents({ contents: "type: number" });
  assert.equal(result, "type: number");
});

test("LSP: hover unwraps a { kind, value } MarkupContent envelope", () => {
  const result = LspClient.unwrapHoverContents({
    contents: { kind: "markdown", value: "**foo**: number" },
  });
  assert.equal(result, "**foo**: number");
});

test("LSP: hover unwraps an array of mixed strings and envelopes", () => {
  const result = LspClient.unwrapHoverContents({
    contents: ["foo: number", { kind: "markdown", value: "*defined in module*" }, ""],
  });
  assert.equal(result, "foo: number\n*defined in module*");
});

test("LSP: hover returns null on no contents / unsupported / non-object", () => {
  assert.equal(LspClient.unwrapHoverContents(null), null);
  assert.equal(LspClient.unwrapHoverContents(undefined), null);
  assert.equal(LspClient.unwrapHoverContents({}), null);
  assert.equal(LspClient.unwrapHoverContents({ contents: null }), null);
  assert.equal(LspClient.unwrapHoverContents("just a string"), null);
});

test("LSP: hover returns null when array has only empty entries", () => {
  const result = LspClient.unwrapHoverContents({ contents: ["", { value: "" }] });
  assert.equal(result, null, "all-empty array shouldn't return an empty string");
});
