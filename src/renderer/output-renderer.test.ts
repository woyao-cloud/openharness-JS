import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setActiveTheme } from "../utils/theme.js";
import { CellGrid } from "./cells.js";
import { looksLikeMarkdown, renderToolOutput, tryParseJson } from "./output-renderer.js";

setActiveTheme("dark");

function gridText(grid: CellGrid): string {
  const lines: string[] = [];
  for (let r = 0; r < grid.height; r++) {
    let line = "";
    for (let c = 0; c < grid.width; c++) line += grid.cells[r]![c]!.char;
    lines.push(line.replace(/\s+$/, ""));
  }
  return lines.join("\n").replace(/\n+$/, "");
}

describe("tryParseJson", () => {
  it("succeeds on object-prefixed valid JSON", () => {
    const r = tryParseJson('{"a":1}');
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.value, { a: 1 });
  });

  it("succeeds on array-prefixed valid JSON", () => {
    const r = tryParseJson("[1,2,3]");
    assert.equal(r.ok, true);
  });

  it("succeeds on JSON with leading whitespace", () => {
    const r = tryParseJson('   \n {"a":1}');
    assert.equal(r.ok, true);
  });

  it("fails on prose-prefixed JSON-shaped string", () => {
    assert.equal(tryParseJson('Result: {"a":1}').ok, false);
  });

  it("fails on malformed JSON", () => {
    assert.equal(tryParseJson("{not json}").ok, false);
  });

  it("fails on a bare number", () => {
    assert.equal(tryParseJson("42").ok, false);
  });
});

describe("looksLikeMarkdown", () => {
  it("matches fenced code blocks", () => {
    assert.equal(looksLikeMarkdown("Some intro\n```ts\nconst x = 1\n```\n"), true);
  });

  it("matches markdown tables (header + separator)", () => {
    assert.equal(looksLikeMarkdown("| col1 | col2 |\n|------|------|\n| a    | b    |"), true);
  });

  it("matches when there are >=2 ATX headings", () => {
    assert.equal(looksLikeMarkdown("# Title\n\nbody\n\n## Subtitle\n"), true);
  });

  it("does NOT match a single bare pipe", () => {
    assert.equal(looksLikeMarkdown("config: a | b | c"), false);
  });

  it("does NOT match a single heading", () => {
    assert.equal(looksLikeMarkdown("# Just one heading\n\nbody"), false);
  });

  it("does NOT match plain prose", () => {
    assert.equal(looksLikeMarkdown("just a sentence with no markup"), false);
  });

  it("matches fenced code blocks with CRLF line endings", () => {
    assert.equal(looksLikeMarkdown("Some intro\r\n```ts\r\nconst x = 1\r\n```\r\n"), true);
  });
});

describe("renderToolOutput", () => {
  it("dispatches to JSON tree when outputType='json' and output parses", () => {
    const grid = new CellGrid(80, 10);
    const consumed = renderToolOutput(grid, 0, 0, '{"a":1}', "json", 80, { status: "done", maxLines: 20, limit: 10 });
    assert.ok(consumed >= 3);
    assert.match(gridText(grid), /"a": 1/);
  });

  it("falls back to plain when outputType='json' but output does not parse", () => {
    const grid = new CellGrid(80, 5);
    const consumed = renderToolOutput(grid, 0, 0, "not json", "json", 80, { status: "done", maxLines: 20, limit: 5 });
    assert.equal(consumed, 1);
    assert.equal(gridText(grid).trim(), "not json");
  });

  it("dispatches to markdown when outputType='markdown'", () => {
    const grid = new CellGrid(80, 10);
    const md = "# Heading\n\nbody";
    const consumed = renderToolOutput(grid, 0, 0, md, "markdown", 80, { status: "done", maxLines: 20, limit: 10 });
    assert.ok(consumed >= 1);
    assert.match(gridText(grid), /Heading/);
  });

  it("dispatches to plain when outputType='plain'", () => {
    const grid = new CellGrid(80, 5);
    const consumed = renderToolOutput(grid, 0, 0, '{"a":1}', "plain", 80, { status: "done", maxLines: 20, limit: 5 });
    assert.equal(consumed, 1);
    assert.match(gridText(grid), /\{"a":1\}/);
  });

  it("image sentinel beats outputType='json'", () => {
    const grid = new CellGrid(80, 5);
    const consumed = renderToolOutput(grid, 0, 0, "__IMAGE__:image/png:abc", "json", 80, {
      status: "done",
      maxLines: 20,
      limit: 5,
    });
    assert.equal(consumed, 1);
    assert.match(gridText(grid), /image/);
  });

  it("outputType='image' without sentinel falls back to plain", () => {
    const grid = new CellGrid(80, 5);
    const consumed = renderToolOutput(grid, 0, 0, "not an image", "image", 80, {
      status: "done",
      maxLines: 20,
      limit: 5,
    });
    assert.equal(consumed, 1);
    assert.match(gridText(grid), /not an image/);
  });

  it("undefined outputType + JSON-shaped output -> JSON tree (heuristic)", () => {
    const grid = new CellGrid(80, 10);
    const consumed = renderToolOutput(grid, 0, 0, "[1,2,3]", undefined, 80, {
      status: "done",
      maxLines: 20,
      limit: 10,
    });
    assert.ok(consumed >= 3);
    assert.match(gridText(grid), /1/);
  });

  it("undefined outputType + markdown -> markdown render (heuristic)", () => {
    const grid = new CellGrid(80, 10);
    const md = "```ts\nconst x = 1\n```\n";
    const consumed = renderToolOutput(grid, 0, 0, md, undefined, 80, { status: "done", maxLines: 20, limit: 10 });
    assert.ok(consumed >= 1);
  });

  it("undefined outputType + plain prose -> plain render", () => {
    const grid = new CellGrid(80, 5);
    const consumed = renderToolOutput(grid, 0, 0, "hello world", undefined, 80, {
      status: "done",
      maxLines: 20,
      limit: 5,
    });
    assert.equal(consumed, 1);
    assert.equal(gridText(grid).trim(), "hello world");
  });

  it("plain renderer truncates with footer when output exceeds maxLines", () => {
    const grid = new CellGrid(80, 30);
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const consumed = renderToolOutput(grid, 0, 0, lines, "plain", 80, { status: "done", maxLines: 10, limit: 30 });
    assert.equal(consumed, 11);
    assert.match(gridText(grid), /… \(50 lines total\)/);
  });

  it("respects opts.limit and stops writing past it", () => {
    const grid = new CellGrid(80, 10);
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const consumed = renderToolOutput(grid, 5, 0, lines, "plain", 80, { status: "done", maxLines: 50, limit: 8 });
    assert.ok(consumed <= 3, `consumed=${consumed} should not exceed limit-row=3`);
  });
});
