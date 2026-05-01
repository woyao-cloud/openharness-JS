# v2.26.0 "Rich Tool Output" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire markdown rendering into the tool-output path and add a static colored JSON-tree renderer, dispatched by an optional `outputType` field plumbed from tool to renderer with heuristic detection as fallback.

**Architecture:** Single new dispatcher (`output-renderer.ts`) replaces the existing image-or-plain branch in `layout-sections.ts:219-239`. Sentinel image flow preserved unchanged; typed dispatch (`outputType` field on `ToolResult`) tried first for the renderer hint; heuristic detection (`JSON.parse` and structural markdown markers) covers tools that don't stamp.

**Tech Stack:** TypeScript, Node test runner (`node:test` + `node:assert/strict`), the project's existing `CellGrid` rendering primitive, no new runtime deps.

**Spec:** `docs/superpowers/specs/2026-05-01-u-c4-rich-tool-output-design.md`

**Files created:**
- `src/renderer/json-tree.ts` (~140 lines)
- `src/renderer/json-tree.test.ts`
- `src/renderer/output-renderer.ts` (~80 lines)
- `src/renderer/output-renderer.test.ts`

**Files modified:**
- `src/Tool.ts` — extend `ToolResult` with optional `outputType?`
- `src/types/events.ts` — extend `ToolCallEnd` with optional `outputType?`
- `src/renderer/layout.ts` — extend `ToolCallInfo` with optional `outputType?`
- `src/repl.ts:1024-1031` — stamp `outputType` from event; bump output storage cap from 500 → 16384
- `src/renderer/layout-sections.ts:219-239` — replace image-or-plain branch with `renderToolOutput` call
- `src/tools/FileReadTool/index.ts` — stamp `outputType` from path extension at text-output return sites
- `src/tools/FileReadTool/index.test.ts` — extend with stamping tests
- `src/tools/WebFetchTool/index.ts` — stamp `outputType` from response Content-Type
- `src/tools/WebFetchTool/index.test.ts` — extend with stamping tests
- `src/renderer/ui-ux.test.ts` — extend with 4 integration tests

**Risks / preconditions:**
- `repl.ts:1027` currently truncates `event.output` to 500 chars before storing in renderer state. This is too tight for JSON tree (most JSON files are >500B) and means rich rendering won't work on real tool outputs without bumping the cap. Task 2 addresses this.
- The existing image branch may already be partially broken on truncated base64 (a 100KB PNG slices to 500B of base64). Out of scope to investigate here — the bump in Task 2 incidentally fixes it.

---

## Task 1: Type plumbing — add optional `outputType` to ToolResult, ToolCallEnd, ToolCallInfo

**Files:**
- Modify: `src/Tool.ts:10-13`
- Modify: `src/types/events.ts:23-28`
- Modify: `src/renderer/layout.ts:46-56`

This task is type-only. No runtime behavior changes; field is optional everywhere. Verifies via `npm run typecheck`.

- [ ] **Step 1: Add `outputType` to `ToolResult` in `src/Tool.ts`**

Replace lines 10-13:

```ts
export type ToolResult = {
  output: string;
  isError: boolean;
  outputType?: "json" | "markdown" | "image" | "plain";
};
```

- [ ] **Step 2: Add `outputType` to `ToolCallEnd` in `src/types/events.ts`**

Replace lines 23-28:

```ts
export type ToolCallEnd = {
  readonly type: "tool_call_end";
  readonly callId: string;
  readonly output: string;
  readonly outputType?: "json" | "markdown" | "image" | "plain";
  readonly isError: boolean;
};
```

- [ ] **Step 3: Add `outputType` to `ToolCallInfo` in `src/renderer/layout.ts`**

Replace lines 46-56:

```ts
export type ToolCallInfo = {
  toolName: string;
  status: "running" | "done" | "error";
  output?: string;
  outputType?: "json" | "markdown" | "image" | "plain";
  args?: string;
  isAgent?: boolean;
  agentDescription?: string;
  liveOutput?: string[];
  startedAt?: number;
  resultSummary?: string;
};
```

- [ ] **Step 4: Run typecheck to verify no breakage**

Run: `npm run typecheck`
Expected: 0 errors. Optional fields are non-breaking.

- [ ] **Step 5: Commit**

```bash
git add src/Tool.ts src/types/events.ts src/renderer/layout.ts
git commit -m "feat(types): add optional outputType to ToolResult / ToolCallEnd / ToolCallInfo (U-C4 plumbing)"
```

---

## Task 2: Bump renderer-state output cap from 500 → 16384

**Files:**
- Modify: `src/repl.ts:1027`

The existing 500-char cap was sized for a plain-text inline preview. JSON tree and markdown rendering need the full output (or at least far more than 500B) to detect/parse correctly. 16384 (16KB) covers typical JSON/markdown files comfortably while keeping renderer state bounded.

- [ ] **Step 1: Change the slice constant**

In `src/repl.ts:1027`, change:

```ts
output: event.output?.slice(0, 500),
```

to:

```ts
output: event.output?.slice(0, 16384),
```

- [ ] **Step 2: Verify build passes**

Run: `npm run typecheck && npm run lint`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/repl.ts
git commit -m "fix(repl): bump tool-output renderer-state cap from 500 to 16384 (U-C4 precondition)"
```

---

## Task 3: REPL handler stamps outputType from event into ToolCallInfo

**Files:**
- Modify: `src/repl.ts:1024-1031`

- [ ] **Step 1: Add outputType to setToolCall call**

In `src/repl.ts`, the existing `tool_call_end` handler (lines 1024-1031) currently calls `renderer.setToolCall(...)` with a fixed set of fields. Add `outputType: event.outputType` to the object literal. Final block reads:

```ts
renderer.setToolCall(event.callId, {
  toolName,
  status: event.isError ? "error" : "done",
  output: event.output?.slice(0, 16384),
  outputType: event.outputType,
  args: prevTc?.args,
  resultSummary: event.output ? summarizeToolOutput(event.output) : undefined,
  startedAt: prevTc?.startedAt,
});
```

- [ ] **Step 2: Verify build passes**

Run: `npm run typecheck && npm run lint`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/repl.ts
git commit -m "feat(repl): pipe outputType from tool_call_end event into ToolCallInfo (U-C4 plumbing)"
```

---

## Task 4: JSON tree renderer (TDD)

**Files:**
- Create: `src/renderer/json-tree.ts`
- Create: `src/renderer/json-tree.test.ts`

Static, theme-colored, depth-truncated JSON pretty-printer. Pure function — takes a parsed value and a `CellGrid`, writes cells, returns rows consumed. Uses the existing theme palette (`utils/theme-data.ts`).

### Step 1-3: Write the failing test scaffold

- [ ] **Step 1: Create `src/renderer/json-tree.test.ts`** with the full test suite

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setActiveTheme } from "../utils/theme.js";
import { CellGrid } from "./cells.js";
import { renderJsonTree } from "./json-tree.js";

setActiveTheme("dark");

function gridToText(grid: CellGrid, fromRow = 0, toRow?: number): string {
  const end = toRow ?? grid.height;
  const lines: string[] = [];
  for (let r = fromRow; r < end; r++) {
    let line = "";
    for (let c = 0; c < grid.width; c++) line += grid.cells[r]![c]!.char;
    lines.push(line.replace(/\s+$/, ""));
  }
  return lines.join("\n").replace(/\n+$/, "");
}

describe("renderJsonTree", () => {
  it("renders a flat object on multiple lines with quoted keys", () => {
    const grid = new CellGrid(80, 10);
    const consumed = renderJsonTree(grid, 0, 0, { a: 1, b: "hi" }, 80, { maxLines: 20, limit: 10 });
    assert.equal(consumed, 4);
    assert.match(gridToText(grid, 0, 4), /\{\n  "a": 1,\n  "b": "hi"\n\}/);
  });

  it("renders a flat array on multiple lines", () => {
    const grid = new CellGrid(80, 10);
    const consumed = renderJsonTree(grid, 0, 0, [1, 2, "three"], 80, { maxLines: 20, limit: 10 });
    assert.equal(consumed, 5);
    assert.match(gridToText(grid, 0, 5), /\[\n  1,\n  2,\n  "three"\n\]/);
  });

  it("renders nested objects with indentation", () => {
    const grid = new CellGrid(80, 20);
    const consumed = renderJsonTree(grid, 0, 0, { outer: { inner: 1 } }, 80, { maxLines: 20, limit: 20 });
    const text = gridToText(grid, 0, consumed);
    assert.match(text, /"outer": \{/);
    assert.match(text, /  "inner": 1/);
  });

  it("collapses objects past maxDepth (3) with {…} marker", () => {
    const grid = new CellGrid(80, 20);
    const deep = { a: { b: { c: { d: { e: 1 } } } } };
    renderJsonTree(grid, 0, 0, deep, 80, { maxLines: 20, limit: 20 });
    const text = gridToText(grid, 0, 20);
    assert.match(text, /\{…\}/);
  });

  it("collapses arrays past maxDepth (3) with [N items] marker", () => {
    const grid = new CellGrid(80, 20);
    const deep = { a: { b: { c: { arr: [1, 2, 3, 4, 5] } } } };
    renderJsonTree(grid, 0, 0, deep, 80, { maxLines: 20, limit: 20 });
    const text = gridToText(grid, 0, 20);
    assert.match(text, /\[5 items\]/);
  });

  it("truncates with '… (N lines total)' footer when exceeding maxLines", () => {
    const grid = new CellGrid(80, 30);
    const big: Record<string, number> = {};
    for (let i = 0; i < 50; i++) big[`k${i}`] = i;
    const consumed = renderJsonTree(grid, 0, 0, big, 80, { maxLines: 10, limit: 30 });
    assert.ok(consumed <= 11, `consumed=${consumed} should be <= 11 (10 lines + truncation footer)`);
    const text = gridToText(grid, 0, consumed);
    assert.match(text, /… \(\d+ lines total\)/);
  });

  it("emits [Circular] for circular references", () => {
    const grid = new CellGrid(80, 20);
    const obj: Record<string, unknown> = { a: 1 };
    obj["self"] = obj;
    renderJsonTree(grid, 0, 0, obj, 80, { maxLines: 20, limit: 20 });
    const text = gridToText(grid, 0, 20);
    assert.match(text, /\[Circular\]/);
  });

  it("renders empty object as {} on a single line", () => {
    const grid = new CellGrid(80, 5);
    const consumed = renderJsonTree(grid, 0, 0, {}, 80, { maxLines: 20, limit: 5 });
    assert.equal(consumed, 1);
    assert.equal(gridToText(grid, 0, 1).trim(), "{}");
  });

  it("renders empty array as [] on a single line", () => {
    const grid = new CellGrid(80, 5);
    const consumed = renderJsonTree(grid, 0, 0, [], 80, { maxLines: 20, limit: 5 });
    assert.equal(consumed, 1);
    assert.equal(gridToText(grid, 0, 1).trim(), "[]");
  });

  it("renders null and booleans as their JSON literals", () => {
    const grid = new CellGrid(80, 10);
    const consumed = renderJsonTree(grid, 0, 0, { a: null, b: true, c: false }, 80, { maxLines: 20, limit: 10 });
    const text = gridToText(grid, 0, consumed);
    assert.match(text, /"a": null/);
    assert.match(text, /"b": true/);
    assert.match(text, /"c": false/);
  });

  it("respects opts.limit and stops writing past it", () => {
    const grid = new CellGrid(80, 10);
    const big: Record<string, number> = {};
    for (let i = 0; i < 100; i++) big[`k${i}`] = i;
    const consumed = renderJsonTree(grid, 5, 0, big, 80, { maxLines: 100, limit: 8 });
    // limit=8 means only rows 5,6,7 are usable (3 rows); consumed must be <= 3
    assert.ok(consumed <= 3, `consumed=${consumed} should not exceed limit-row=3`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails (file does not exist yet)**

Run: `npx tsc --noEmit && node --test --import tsx src/renderer/json-tree.test.ts`
Expected: FAIL with "Cannot find module './json-tree.js'" or equivalent.

(If your project uses a different test runner script, run `npm run test:cli -- --grep renderJsonTree` instead. Adjust as needed for the project's test runner config.)

- [ ] **Step 3: Implement `src/renderer/json-tree.ts`**

```ts
/**
 * Static JSON tree renderer for tool output.
 * Theme-colored, indented, depth-truncated, line-truncated.
 */

import { getTheme } from "../utils/theme-data.js";
import { type CellGrid, type Style } from "./cells.js";

const s = (fg: string | null, bold = false, dim = false): Style => ({ fg, bg: null, bold, dim, underline: false });

const MAX_DEPTH = 3;

let S_KEY: Style;
let S_STRING: Style;
let S_NUMBER: Style;
let S_PUNCT: Style;
let S_TRUNC: Style;
let _stylesInit = false;

function ensureStyles() {
  if (_stylesInit) return;
  _stylesInit = true;
  const t = getTheme();
  S_KEY = s(t.user);
  S_STRING = s(t.success);
  S_NUMBER = s(t.tool);
  S_PUNCT = s(null, false, true);
  S_TRUNC = s(null, false, true);
}

type Token = { text: string; style: Style };
type Line = { indent: number; tokens: Token[] };

export function renderJsonTree(
  grid: CellGrid,
  row: number,
  col: number,
  value: unknown,
  width: number,
  opts: { maxLines: number; limit: number },
): number {
  ensureStyles();
  const lines: Line[] = [];
  const seen = new Set<unknown>();
  emitValue(lines, value, 0, 0, seen);

  const maxRows = Math.min(opts.limit - row, opts.maxLines);
  if (maxRows <= 0) return 0;

  const truncated = lines.length > maxRows;
  const visible = truncated ? lines.slice(0, maxRows - 1) : lines;

  let r = row;
  for (const line of visible) {
    if (r >= opts.limit) break;
    let c = col + line.indent;
    for (const tok of line.tokens) {
      for (let i = 0; i < tok.text.length; i++) {
        if (c >= col + width) break;
        grid.setCell(r, c, tok.text[i]!, tok.style);
        c++;
      }
    }
    r++;
  }
  if (truncated && r < opts.limit) {
    const footer = `… (${lines.length} lines total)`;
    grid.writeText(r, col, footer.slice(0, width), S_TRUNC);
    r++;
  }
  return r - row;
}

function emitValue(out: Line[], value: unknown, indent: number, depth: number, seen: Set<unknown>): void {
  if (value === null) { out.push({ indent, tokens: [{ text: "null", style: S_NUMBER }] }); return; }
  if (typeof value === "string") { out.push({ indent, tokens: [{ text: JSON.stringify(value), style: S_STRING }] }); return; }
  if (typeof value === "number" || typeof value === "boolean") {
    out.push({ indent, tokens: [{ text: String(value), style: S_NUMBER }] });
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) { out.push({ indent, tokens: [{ text: "[]", style: S_PUNCT }] }); return; }
    if (depth >= MAX_DEPTH) {
      out.push({ indent, tokens: [{ text: `[${value.length} items]`, style: S_TRUNC }] });
      return;
    }
    if (seen.has(value)) { out.push({ indent, tokens: [{ text: "[Circular]", style: S_TRUNC }] }); return; }
    seen.add(value);
    out.push({ indent, tokens: [{ text: "[", style: S_PUNCT }] });
    for (let i = 0; i < value.length; i++) {
      emitValueAsItem(out, value[i], indent + 2, depth + 1, seen, i < value.length - 1);
    }
    out.push({ indent, tokens: [{ text: "]", style: S_PUNCT }] });
    seen.delete(value);
    return;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) { out.push({ indent, tokens: [{ text: "{}", style: S_PUNCT }] }); return; }
    if (depth >= MAX_DEPTH) {
      out.push({ indent, tokens: [{ text: "{…}", style: S_TRUNC }] });
      return;
    }
    if (seen.has(value)) { out.push({ indent, tokens: [{ text: "[Circular]", style: S_TRUNC }] }); return; }
    seen.add(value);
    out.push({ indent, tokens: [{ text: "{", style: S_PUNCT }] });
    for (let i = 0; i < entries.length; i++) {
      const [k, v] = entries[i]!;
      emitObjectEntry(out, k, v, indent + 2, depth + 1, seen, i < entries.length - 1);
    }
    out.push({ indent, tokens: [{ text: "}", style: S_PUNCT }] });
    seen.delete(value);
    return;
  }
  out.push({ indent, tokens: [{ text: String(value), style: S_TRUNC }] });
}

function emitValueAsItem(
  out: Line[],
  value: unknown,
  indent: number,
  depth: number,
  seen: Set<unknown>,
  trailingComma: boolean,
): void {
  const before = out.length;
  emitValue(out, value, indent, depth, seen);
  if (trailingComma && out.length > before) {
    const last = out[out.length - 1]!;
    last.tokens.push({ text: ",", style: S_PUNCT });
  }
}

function emitObjectEntry(
  out: Line[],
  key: string,
  value: unknown,
  indent: number,
  depth: number,
  seen: Set<unknown>,
  trailingComma: boolean,
): void {
  const keyTok: Token = { text: JSON.stringify(key), style: S_KEY };
  const colonTok: Token = { text: ": ", style: S_PUNCT };

  // Inline primitives onto the same line as the key.
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const valStyle = typeof value === "string" ? S_STRING : S_NUMBER;
    const valText = typeof value === "string" ? JSON.stringify(value) : String(value);
    const tokens: Token[] = [keyTok, colonTok, { text: valText, style: valStyle }];
    if (trailingComma) tokens.push({ text: ",", style: S_PUNCT });
    out.push({ indent, tokens });
    return;
  }

  // Empty container inlines too: "key": {} / "key": []
  if (Array.isArray(value) && value.length === 0) {
    const tokens: Token[] = [keyTok, colonTok, { text: "[]", style: S_PUNCT }];
    if (trailingComma) tokens.push({ text: ",", style: S_PUNCT });
    out.push({ indent, tokens });
    return;
  }
  if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) {
    const tokens: Token[] = [keyTok, colonTok, { text: "{}", style: S_PUNCT }];
    if (trailingComma) tokens.push({ text: ",", style: S_PUNCT });
    out.push({ indent, tokens });
    return;
  }

  // Depth-collapsed container also inlines.
  if (depth >= MAX_DEPTH) {
    const collapsed = Array.isArray(value) ? `[${value.length} items]` : "{…}";
    out.push({ indent, tokens: [keyTok, colonTok, { text: collapsed, style: S_TRUNC }] });
    return;
  }

  // Non-empty container: open bracket on key line, body indented, close bracket on its own line.
  const opener = Array.isArray(value) ? "[" : "{";
  const closer = Array.isArray(value) ? "]" : "}";
  out.push({ indent, tokens: [keyTok, colonTok, { text: opener, style: S_PUNCT }] });

  if (seen.has(value)) {
    out.push({ indent: indent + 2, tokens: [{ text: "[Circular]", style: S_TRUNC }] });
  } else {
    seen.add(value);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        emitValueAsItem(out, value[i], indent + 2, depth + 1, seen, i < value.length - 1);
      }
    } else {
      const entries = Object.entries(value as Record<string, unknown>);
      for (let i = 0; i < entries.length; i++) {
        const [ck, cv] = entries[i]!;
        emitObjectEntry(out, ck, cv, indent + 2, depth + 1, seen, i < entries.length - 1);
      }
    }
    seen.delete(value);
  }

  const closerTokens: Token[] = [{ text: closer, style: S_PUNCT }];
  if (trailingComma) closerTokens.push({ text: ",", style: S_PUNCT });
  out.push({ indent, tokens: closerTokens });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:cli -- src/renderer/json-tree.test.ts`
Expected: 11/11 passing. (10 named tests + 1 from "respects opts.limit" that may need adjustment based on actual output sizes.)

If any test fails on an exact row count, check whether `emitValue` or `emitObjectEntry` is producing the expected number of lines for that input. Adjust the expected `consumed` value in the test rather than the implementation if the layout matches the visual spec but my arithmetic is off.

- [ ] **Step 5: Run lint to verify clean**

Run: `npm run lint -- src/renderer/json-tree.ts src/renderer/json-tree.test.ts`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/json-tree.ts src/renderer/json-tree.test.ts
git commit -m "feat(renderer): add static JSON tree renderer with depth + line truncation (U-C4)"
```

---

## Task 5: Output dispatcher (TDD)

**Files:**
- Create: `src/renderer/output-renderer.ts`
- Create: `src/renderer/output-renderer.test.ts`

The single integration point that `layout-sections.ts` will call. Image sentinel wins; then typed dispatch on `outputType`; then heuristic fallback.

- [ ] **Step 1: Create `src/renderer/output-renderer.test.ts`**

```ts
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
    // Heading should be present in some form
    assert.match(gridText(grid), /Heading/);
  });

  it("dispatches to plain when outputType='plain'", () => {
    const grid = new CellGrid(80, 5);
    const consumed = renderToolOutput(grid, 0, 0, '{"a":1}', "plain", 80, { status: "done", maxLines: 20, limit: 5 });
    assert.equal(consumed, 1);
    // Even though it parses as JSON, the explicit "plain" stamp wins
    assert.match(gridText(grid), /\{"a":1\}/);
  });

  it("image sentinel beats outputType='json'", () => {
    const grid = new CellGrid(80, 5);
    // sentinel takes precedence; we don't actually need a parseable image here, just the prefix
    const consumed = renderToolOutput(grid, 0, 0, "__IMAGE__:image/png:abc", "json", 80, { status: "done", maxLines: 20, limit: 5 });
    assert.equal(consumed, 1);
    assert.match(gridText(grid), /image/);
  });

  it("outputType='image' without sentinel falls back to plain", () => {
    const grid = new CellGrid(80, 5);
    const consumed = renderToolOutput(grid, 0, 0, "not an image", "image", 80, { status: "done", maxLines: 20, limit: 5 });
    assert.equal(consumed, 1);
    assert.match(gridText(grid), /not an image/);
  });

  it("undefined outputType + JSON-shaped output -> JSON tree (heuristic)", () => {
    const grid = new CellGrid(80, 10);
    const consumed = renderToolOutput(grid, 0, 0, "[1,2,3]", undefined, 80, { status: "done", maxLines: 20, limit: 10 });
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
    const consumed = renderToolOutput(grid, 0, 0, "hello world", undefined, 80, { status: "done", maxLines: 20, limit: 5 });
    assert.equal(consumed, 1);
    assert.equal(gridText(grid).trim(), "hello world");
  });

  it("plain renderer truncates with footer when output exceeds maxLines", () => {
    const grid = new CellGrid(80, 30);
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const consumed = renderToolOutput(grid, 0, 0, lines, "plain", 80, { status: "done", maxLines: 10, limit: 30 });
    assert.equal(consumed, 11); // 10 lines + footer
    assert.match(gridText(grid), /… \(50 lines total\)/);
  });

  it("respects opts.limit and stops writing past it", () => {
    const grid = new CellGrid(80, 10);
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const consumed = renderToolOutput(grid, 5, 0, lines, "plain", 80, { status: "done", maxLines: 50, limit: 8 });
    // Only rows 5,6,7 usable -> consumed must be <= 3
    assert.ok(consumed <= 3, `consumed=${consumed} should not exceed limit-row=3`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails (file does not exist)**

Run: `npm run test:cli -- src/renderer/output-renderer.test.ts`
Expected: FAIL with module-not-found error.

- [ ] **Step 3: Implement `src/renderer/output-renderer.ts`**

```ts
/**
 * Tool output dispatcher.
 *
 * Detection chain (stops at first hit):
 *   1. __IMAGE__: sentinel  -> renderImageInline
 *   2. outputType="json"    -> renderJsonTree (fallback to plain on parse fail)
 *   3. outputType="markdown" -> renderMarkdown
 *   4. outputType="plain"|"image" -> renderPlain (image without sentinel is malformed)
 *   5. heuristic JSON parse -> renderJsonTree
 *   6. heuristic markdown   -> renderMarkdown
 *   7. fallback             -> renderPlain
 */

import { isImageOutput, renderImageInline } from "./image.js";
import { renderJsonTree } from "./json-tree.js";
import { renderMarkdown } from "./markdown.js";
import { type CellGrid, type Style } from "./cells.js";

export type OutputType = "json" | "markdown" | "image" | "plain";

const S_DIM: Style = { fg: null, bg: null, bold: false, dim: true, underline: false };
const S_ERROR: Style = { fg: "red", bg: null, bold: false, dim: false, underline: false };

export function renderToolOutput(
  grid: CellGrid,
  row: number,
  col: number,
  output: string,
  outputType: OutputType | undefined,
  width: number,
  opts: { status: "running" | "done" | "error"; maxLines: number; limit: number },
): number {
  // 1. Image sentinel always wins.
  if (isImageOutput(output)) {
    if (row >= opts.limit) return 0;
    const label = renderImageInline(output);
    grid.writeText(row, col, label.slice(0, width), S_DIM);
    return 1;
  }

  // 2-4. Typed dispatch.
  if (outputType === "json") {
    const parsed = tryParseJson(output);
    if (parsed.ok) return renderJsonTree(grid, row, col, parsed.value, width, { maxLines: opts.maxLines, limit: opts.limit });
    return renderPlain(grid, row, col, output, width, opts);
  }
  if (outputType === "markdown") {
    return renderMarkdown(grid, row, col, output, width, false, opts.limit);
  }
  if (outputType === "plain" || outputType === "image") {
    return renderPlain(grid, row, col, output, width, opts);
  }

  // 5-7. Heuristic fallback (outputType undefined).
  const json = tryParseJson(output);
  if (json.ok) return renderJsonTree(grid, row, col, json.value, width, { maxLines: opts.maxLines, limit: opts.limit });
  if (looksLikeMarkdown(output)) return renderMarkdown(grid, row, col, output, width, false, opts.limit);
  return renderPlain(grid, row, col, output, width, opts);
}

export function tryParseJson(s: string): { ok: true; value: unknown } | { ok: false } {
  const t = s.trimStart();
  if (t[0] !== "{" && t[0] !== "[") return { ok: false };
  try {
    return { ok: true, value: JSON.parse(t) };
  } catch {
    return { ok: false };
  }
}

const FENCED_RE = /```[\w]*\n/;
const TABLE_RE = /^\|.+\|\s*\n\|[\s:|-]+\|/m;
const HEADING_RE = /^#{1,6}\s+\S/gm;

export function looksLikeMarkdown(s: string): boolean {
  if (FENCED_RE.test(s)) return true;
  if (TABLE_RE.test(s)) return true;
  const headings = s.match(HEADING_RE);
  if (headings && headings.length >= 2) return true;
  return false;
}

function renderPlain(
  grid: CellGrid,
  row: number,
  col: number,
  output: string,
  width: number,
  opts: { status: "running" | "done" | "error"; maxLines: number; limit: number },
): number {
  const outLines = output.split("\n");
  const showLines = outLines.slice(0, opts.maxLines);
  const lineStyle: Style = opts.status === "error" ? S_ERROR : S_DIM;
  let r = row;
  for (const line of showLines) {
    if (r >= opts.limit) break;
    grid.writeTextWithLinks(r, col, line.slice(0, width), lineStyle, col + width);
    r++;
  }
  if (outLines.length > opts.maxLines && r < opts.limit) {
    grid.writeText(r, col, `… (${outLines.length} lines total)`, S_DIM);
    r++;
  }
  return r - row;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:cli -- src/renderer/output-renderer.test.ts`
Expected: 23/23 passing (6 tryParseJson + 6 looksLikeMarkdown + 11 renderToolOutput).

- [ ] **Step 5: Run lint**

Run: `npm run lint -- src/renderer/output-renderer.ts src/renderer/output-renderer.test.ts`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/output-renderer.ts src/renderer/output-renderer.test.ts
git commit -m "feat(renderer): add tool-output dispatcher with typed + heuristic detection (U-C4)"
```

---

## Task 6: Wire dispatcher into `layout-sections.ts` + integration tests

**Files:**
- Modify: `src/renderer/layout-sections.ts:9` (import) and `:219-239` (replace branch)
- Modify: `src/renderer/ui-ux.test.ts` (extend with 4 integration tests)

This is the integration point. After this task, the renderer actually uses the new code path for tool output.

- [ ] **Step 1: Add import to `layout-sections.ts`**

In `src/renderer/layout-sections.ts`, line 9 currently reads:

```ts
import { isImageOutput, renderImageInline } from "./image.js";
```

Replace with:

```ts
import { renderToolOutput } from "./output-renderer.js";
```

(`isImageOutput` and `renderImageInline` are now used inside `output-renderer.ts`, not directly here.)

- [ ] **Step 2: Replace the tool-output branch at lines 219-239**

Find:

```ts
if (tc.output && tc.status !== "running" && isExpanded && r < limit) {
  if (isImageOutput(tc.output)) {
    const label = renderImageInline(tc.output);
    grid.writeText(r, 6, label.slice(0, w - 8), S_DIM);
    r++;
    continue;
  }
  const outLines = tc.output.split("\n");
  const maxOut = 20;
  const showLines = outLines.slice(0, maxOut);
  for (const line of showLines) {
    if (r >= limit) break;
    const lineStyle = tc.status === "error" ? S_ERROR : S_DIM;
    grid.writeTextWithLinks(r, 6, line.slice(0, w - 8), lineStyle, w - 2);
    r++;
  }
  if (outLines.length > maxOut && r < limit) {
    grid.writeText(r, 6, `… (${outLines.length} lines total)`, S_DIM);
    r++;
  }
}
```

Replace with:

```ts
if (tc.output && tc.status !== "running" && isExpanded && r < limit) {
  const consumed = renderToolOutput(grid, r, 6, tc.output, tc.outputType, w - 8, {
    status: tc.status,
    maxLines: 20,
    limit,
  });
  r += consumed;
}
```

- [ ] **Step 3: Run typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: 0 errors. (`S_ERROR` may now be unused in `layout-sections.ts` — if Biome flags it, remove its declaration too.)

- [ ] **Step 4: Add 4 integration tests to `src/renderer/ui-ux.test.ts`**

At the bottom of `src/renderer/ui-ux.test.ts`, append:

```ts
describe("U-C4: rich tool output rendering", () => {
  it("renders JSON tree for tool output stamped outputType='json'", () => {
    const tc: ToolCallInfo = {
      toolName: "Read",
      status: "done",
      output: '{"name":"openharness","version":"2.26.0"}',
      outputType: "json",
    };
    const state = makeState({ toolCalls: new Map([["a", tc]]) });
    const grid = rasterize(state, 80, 30);
    const text = gridToTextSafe(grid);
    assert.match(text, /"name": "openharness"/);
    assert.match(text, /"version": "2\.26\.0"/);
  });

  it("renders markdown for tool output stamped outputType='markdown'", () => {
    const md = "# Title\n\n## Subtitle\n\nbody text";
    const tc: ToolCallInfo = {
      toolName: "Read",
      status: "done",
      output: md,
      outputType: "markdown",
    };
    const state = makeState({ toolCalls: new Map([["a", tc]]) });
    const grid = rasterize(state, 80, 30);
    const text = gridToTextSafe(grid);
    assert.match(text, /Title/);
    assert.match(text, /Subtitle/);
  });

  it("falls back to plain when outputType='plain' is set explicitly", () => {
    const tc: ToolCallInfo = {
      toolName: "Bash",
      status: "done",
      output: '{"this":"would normally render as json"}',
      outputType: "plain",
    };
    const state = makeState({ toolCalls: new Map([["a", tc]]) });
    const grid = rasterize(state, 80, 30);
    const text = gridToTextSafe(grid);
    // Plain rendering keeps the JSON literal as-is on a single line, no key coloring/indenting
    assert.match(text, /\{"this":"would normally render as json"\}/);
  });

  it("uses heuristic JSON detection when outputType is undefined", () => {
    const tc: ToolCallInfo = {
      toolName: "Bash",
      status: "done",
      output: '{"foo":"bar"}',
      // outputType intentionally undefined
    };
    const state = makeState({ toolCalls: new Map([["a", tc]]) });
    const grid = rasterize(state, 80, 30);
    const text = gridToTextSafe(grid);
    assert.match(text, /"foo": "bar"/);
  });
});

// Helper, place near other test helpers if not already present:
function gridToTextSafe(grid: ReturnType<typeof rasterize>): string {
  const lines: string[] = [];
  for (let r = 0; r < grid.height; r++) {
    let line = "";
    for (let c = 0; c < grid.width; c++) line += grid.cells[r]![c]!.char;
    lines.push(line.replace(/\s+$/, ""));
  }
  return lines.join("\n");
}
```

If `gridToTextSafe` (or an equivalent helper) already exists in `ui-ux.test.ts`, reuse it instead of redeclaring. Search first: `grep -n "function grid" src/renderer/ui-ux.test.ts`.

Also: the tool-call display section requires `isExpanded` to be true for output rendering. If the existing `makeState` helper doesn't enable expansion by default, the tests need to also set the expansion state. Check the existing state shape: `grep -n "expanded\|isExpanded" src/renderer/ui-ux.test.ts` — and follow the pattern existing tool-call output tests use.

- [ ] **Step 5: Run integration tests**

Run: `npm run test:cli -- src/renderer/ui-ux.test.ts`
Expected: All existing tests pass + 4 new "U-C4" tests pass.

- [ ] **Step 6: Run full renderer suite**

Run: `npm run test:cli -- src/renderer`
Expected: All renderer tests green.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/layout-sections.ts src/renderer/ui-ux.test.ts
git commit -m "feat(renderer): wire renderToolOutput dispatcher into tool-call section (U-C4)"
```

---

## Task 7: Stamp `FileReadTool` with `outputType` from path extension

**Files:**
- Modify: `src/tools/FileReadTool/index.ts:115` (PDF text), `:144` (notebook), `:163` (regular text)
- Modify: `src/tools/FileReadTool/index.test.ts` (extend)

The image-output return sites (lines 75, 120) keep using the `__IMAGE__:` sentinel and do not need stamping — the sentinel takes precedence anyway. We stamp only the text-output return sites.

- [ ] **Step 1: Add helper at top of `FileReadTool/index.ts`**

After the existing `IMAGE_EXTENSIONS` set declaration (around line 15), add:

```ts
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const JSON_EXTENSIONS = new Set([".json"]);

function outputTypeFromExt(ext: string): "json" | "markdown" | "plain" {
  if (JSON_EXTENSIONS.has(ext)) return "json";
  if (MARKDOWN_EXTENSIONS.has(ext)) return "markdown";
  return "plain";
}
```

- [ ] **Step 2: Stamp at the three text-output return sites**

For each of the three `return { output, isError: false }` sites that produce text (NOT the image sites), add `outputType`. Identify the `ext` variable in scope at each site:

- Around line 115 (PDF text branch): the `ext` for a PDF is `.pdf`, which maps to `"plain"`. Update:
  ```ts
  return { output: pageTexts.join("\n\n"), isError: false, outputType: "plain" };
  ```

- Around line 144 (notebook branch): `.ipynb` maps to `"plain"` (notebooks are JSON internally but we render the parsed text result, not the JSON). Update:
  ```ts
  return { output: parts.join("\n\n"), isError: false, outputType: "plain" };
  ```

- Around line 163 (regular text-file branch): use `outputTypeFromExt(ext)`. Update:
  ```ts
  return { output: result, isError: false, outputType: outputTypeFromExt(ext) };
  ```

(If the `ext` variable isn't in scope at line 163, derive it inline: `path.extname(filePath).toLowerCase()`.)

Image-output sites (lines 75 and 120): leave untouched. The sentinel format wins.

Error sites (lines 57, 166, 169, 171): leave untouched. Error output stays plain by default.

- [ ] **Step 3: Add tests to `src/tools/FileReadTool/index.test.ts`**

Append three tests near the existing happy-path tests:

```ts
it("stamps outputType='json' when reading a .json file", async () => {
  const tmp = path.join(os.tmpdir(), `fr-${Date.now()}.json`);
  await fs.writeFile(tmp, '{"a":1}');
  try {
    const r = await FileReadTool.call({ file_path: tmp }, { workingDir: process.cwd() });
    assert.equal(r.outputType, "json");
  } finally {
    await fs.rm(tmp, { force: true });
  }
});

it("stamps outputType='markdown' when reading a .md file", async () => {
  const tmp = path.join(os.tmpdir(), `fr-${Date.now()}.md`);
  await fs.writeFile(tmp, "# Hello");
  try {
    const r = await FileReadTool.call({ file_path: tmp }, { workingDir: process.cwd() });
    assert.equal(r.outputType, "markdown");
  } finally {
    await fs.rm(tmp, { force: true });
  }
});

it("stamps outputType='plain' when reading a .txt file", async () => {
  const tmp = path.join(os.tmpdir(), `fr-${Date.now()}.txt`);
  await fs.writeFile(tmp, "hello");
  try {
    const r = await FileReadTool.call({ file_path: tmp }, { workingDir: process.cwd() });
    assert.equal(r.outputType, "plain");
  } finally {
    await fs.rm(tmp, { force: true });
  }
});
```

If imports for `os`, `path`, `fs` aren't already in the test file, add:
```ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
```

- [ ] **Step 4: Run tests**

Run: `npm run test:cli -- src/tools/FileReadTool`
Expected: All existing tests pass + 3 new stamping tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools/FileReadTool/index.ts src/tools/FileReadTool/index.test.ts
git commit -m "feat(tools): stamp outputType on FileReadTool by file extension (U-C4)"
```

---

## Task 8: Stamp `WebFetchTool` with `outputType` from response Content-Type

**Files:**
- Modify: `src/tools/WebFetchTool/index.ts:111` (success return)
- Modify: `src/tools/WebFetchTool/index.test.ts` (extend)

- [ ] **Step 1: Stamp at the success-return site**

Around line 111, the existing return is:
```ts
return { output: text, isError: false };
```

Replace with:
```ts
const ct = (response.headers.get("content-type") ?? "").toLowerCase();
const outputType = ct.includes("application/json") ? "json"
                 : ct.includes("text/markdown") ? "markdown"
                 : "plain";
return { output: text, isError: false, outputType };
```

(If `response` isn't the variable name in scope, use whatever holds the `Response` object. Check the code immediately above line 111.)

Error returns (lines 69, 73, 77, 90, 113): leave untouched.

- [ ] **Step 2: Add tests to `src/tools/WebFetchTool/index.test.ts`**

The test file likely uses a fetch mock. Find the existing successful-fetch test, then add two adjacent tests that vary the mocked response's `content-type` header. Pattern to follow:

```ts
it("stamps outputType='json' when response Content-Type is application/json", async () => {
  // Mock fetch to return application/json content-type.
  // Reuse the file's existing mock helper if present; otherwise use globalThis.fetch override.
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

it("stamps outputType='markdown' when response Content-Type is text/markdown", async () => {
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
```

If the existing test file uses a different mocking strategy (e.g., a module-level `vi.mock`-style helper or a private hook for injecting a fetch impl), follow that pattern instead. Search for the existing successful-fetch test as a model: `grep -n "Content-Type\|content-type\|globalThis.fetch" src/tools/WebFetchTool/index.test.ts`.

- [ ] **Step 3: Run tests**

Run: `npm run test:cli -- src/tools/WebFetchTool`
Expected: All existing tests pass + 2 new stamping tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/tools/WebFetchTool/index.ts src/tools/WebFetchTool/index.test.ts
git commit -m "feat(tools): stamp outputType on WebFetchTool from response Content-Type (U-C4)"
```

---

## Task 9: Run full suite + smoke test

**Files:** none modified. This is verification.

- [ ] **Step 1: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: 0 errors.

- [ ] **Step 2: Full test suite**

Run: `npm run test:cli`
Expected: 1450 passing (was 1418; +32). If the count differs by a few, that's fine — the breakdown is approximate. Critical: zero failures.

- [ ] **Step 3: SDK smoke test (regression check)**

Run: `node packages/sdk/test/smoke/smoke.mjs`
Expected: passes. (No SDK regressions expected — this is pure renderer + optional-field plumbing.)

- [ ] **Step 4: Manual REPL smoke (~3 min)**

Build and launch:
```bash
npm run build
node dist/main.js
```

In the REPL:
1. Type a prompt that triggers `Read package.json` — observe colored JSON tree (keys, strings, numbers in distinct colors, indented).
2. Type a prompt that triggers `Read README.md` — observe rendered headings, code blocks (if README has them).
3. Type a prompt that triggers `Bash(echo '{"hello":"world"}')` — observe heuristic JSON tree (no stamping but parses).
4. Type a prompt that triggers `Bash(echo "config: a | b | c")` — observe plain rendering (no false-positive markdown table).

If any of the four smoke checks does not render as expected, fix before proceeding to release.

---

## Self-review

Spec coverage check (each spec section maps to at least one task):

| Spec section | Task |
|---|---|
| Component 1 (type plumbing) | Task 1 |
| Component 2 (tool stamping) | Tasks 7, 8 |
| Component 3 (output-renderer.ts) | Task 5 |
| Component 4 (json-tree.ts) | Task 4 |
| Component 5 (wire into layout-sections) | Task 6 |
| Data flow | Tasks 1, 3, 6 |
| Error handling (circular refs, malformed JSON, sentinel-precedence, depth/line truncation) | Tasks 4, 5 |
| Testing matrix (json-tree 10, output-renderer 23, FileReadTool +3, WebFetchTool +2, ui-ux +4) | Tasks 4, 5, 6, 7, 8 |
| Build sequence (single PR, ordered to keep build green) | Task ordering 1→2→3→4→5→6→7→8→9 |
| Verification (manual REPL JSON tree, markdown, heuristic, conservative MD) | Task 9 step 4 |

Precondition added during plan-review (not in spec): **Task 2 — bump tc.output cap from 500 to 16384.** Without this, JSON tree never fires on real files because parses fail on truncated input. This is a real defect in the existing code that the spec did not catch.
