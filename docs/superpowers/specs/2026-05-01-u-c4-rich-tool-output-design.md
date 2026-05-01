# v2.26.0 "Rich Tool Output" — Design Spec

**Date:** 2026-05-01
**Status:** Draft
**Tier:** U-C4 (UI/UX-parity plan, `~/.claude/plans/2-typescript-sdk-moonlit-hinton.md`)
**Target release:** v2.26.0 — single PR, ~3 days

## Context

v2.25.0 (shipped 2026-04-30) closed Tier U-C1/U-C2/U-C3 of the 2026-04-27 UI/UX-parity plan, leaving only U-C4 (rich tool-result display) and U-C5 (nested tool-call display) in the audit. This spec covers **only U-C4**. U-C5 remains deferred — it requires a query event-protocol RFC for `parentCallId` plumbing.

The audit's original framing of U-C4 was "rich tool-result display: tables / image / structured-JSON renderers" with "tool-output schema. Coupled to query event-protocol changes. Needs UX spec first." Grep-first inspection significantly reduced scope:

**Already shipped (no work needed):**
- **Image rendering** — `src/renderer/image.ts` ships Kitty/iTerm2 protocols, wired at `src/renderer/layout-sections.ts:220-221` via `__IMAGE__:` sentinel detection. Untouched by this release.
- **Markdown table rendering** — `src/renderer/markdown.ts:362-420` (`renderTable`) renders headers, separators, and column-aligned data rows.

**Genuinely missing (real U-C4 scope):**
- **Tool output → markdown dispatch** — markdown rendering only runs inside `renderMarkdown()` for assistant-message text. Tool output bypasses it entirely (`layout-sections.ts:226` does plain `output.split("\n")`). A tool that returns markdown-formatted output renders as plain lines.
- **JSON tree pretty-print** — no renderer exists.
- **Auto-detection / typed dispatch** — image uses a sentinel prefix; nothing else has type information available at render time.

## Goals

1. **Wire markdown rendering into the tool-output path.** A tool returning markdown (fenced code blocks, tables, headings) should render as styled markdown, not plain text.
2. **Add a static JSON-tree renderer.** A tool returning JSON should render as a colored, indented, depth-truncated tree.
3. **Plumb a renderer hint (`outputType`) from tool to renderer.** Tools that know their output type declare it; the renderer dispatches by declared type. Heuristic detection remains as a fallback for tools that don't declare and for MCP tools that pass through as text.
4. **Keep the existing image path untouched.** `__IMAGE__:` sentinel detection still wins.

## Non-goals

- **Interactive JSON viewer (jless/fx-style TUI).** Out of scope. Static pretty-print only — interactive viewers are pull-mode (user invokes on demand), inline tool output is push-mode (renders as it streams in). Different UX patterns; conflating them adds complexity that doesn't pay off.
- **MCP image content preservation.** Currently `src/mcp/client.ts:181-184` filters MCP `content[]` for `type === "text"` only and drops images/resources/audio. Refactoring it would add ~2 days of plumbing including reconnect/retry edge cases. Documented as v2.27+ follow-up if real-world MCP servers surface image content (none of the popular MCP servers currently emit images).
- **Stamping every built-in tool with `outputType`.** Only `FileReadTool` and `WebFetchTool` get explicit stamping in this release. The other 37 tools rely on heuristic detection — which is correct because most return either plain text (Glob, Grep, LS, Bash output, etc.) or already-known formats that the heuristic catches reliably.
- **Configurability.** No opt-out flag, no per-tool override, no theme override for JSON-tree colors. Punt until users ask. (Same call as v2.25.0's tool-color map.)
- **Streaming JSON parse.** Final `tc.output` only — `tc.liveOutput` (streaming, while `status === "running"`) stays plain because mid-stream JSON would be incomplete and unparseable.

## Approach

**Approach 4 (typed dispatch with heuristic fallback)** chosen over three alternatives:

| Approach | Detection | Trade-off |
|---|---|---|
| (A1) Heuristic only | regex/JSON.parse on every tool output | Pure renderer, ~2 days. Risk: false positives. Throws away available type info. |
| (A2) Sentinel prefix per format | `__JSON__:`/`__MARKDOWN__:` sentinels | Zero false positives but requires retrofitting every tool. Third-party MCP tools never opt in. |
| (A3) Hybrid (sentinel + heuristic) | Sentinels for our tools, heuristic for MCP | Same outcome as A4 but invents an OH-specific format protocol when types are already declarable. |
| **(A4) Typed dispatch + heuristic fallback** ✅ chosen | `outputType?` field plumbed from tool to renderer; heuristic as fallback | ~3 days. Best practice — uses available type information, falls back gracefully. Aligned with how MCP/CC/OpenAI tool schemas work. |

A4 wins because it's on best practice for the controllable surface (tools we own) without forcing scope creep into MCP. The heuristic fallback covers MCP and any tool that doesn't stamp.

The image sentinel (`__IMAGE__:`) is **preserved unchanged** and takes precedence over `outputType`. The image flow has no benefit from migrating to typed dispatch — sentinel detection is as cheap as a field check.

## Component design

### Component 1 — Type plumbing

**Three type extensions, all optional fields, no breaking changes:**

```ts
// src/Tool.ts:10
export type ToolResult = {
  output: string;
  isError: boolean;
  outputType?: "json" | "markdown" | "image" | "plain";  // NEW
};

// src/types/events.ts:23
export type ToolCallEnd = {
  readonly type: "tool_call_end";
  readonly callId: string;
  readonly output: string;
  readonly outputType?: "json" | "markdown" | "image" | "plain";  // NEW
  readonly isError: boolean;
};

// src/renderer/layout.ts:46
export type ToolCallInfo = {
  // ...existing fields
  output?: string;
  outputType?: "json" | "markdown" | "image" | "plain";  // NEW
};
```

**REPL state population** (`src/repl.ts` where `tool_call_end` events are handled): one extra line, `tc.outputType = event.outputType`. Field is optional everywhere — undefined is the legacy "auto" path.

`src/types/message.ts:ToolResult` (the conversation-history variant) is intentionally NOT extended. `outputType` is a renderer hint, not LLM-visible content. The model sees only `output`.

### Component 2 — Tool stamping (two tools)

**`src/tools/FileReadTool/index.ts`:** stamp from path extension at the return site.
```ts
const ext = path.extname(filePath).toLowerCase();
const outputType = ext === ".json" ? "json"
                 : ext === ".md" || ext === ".markdown" ? "markdown"
                 : "plain";
return { output, isError: false, outputType };
```

**`src/tools/WebFetchTool/index.ts`:** stamp from response Content-Type header.
```ts
const ct = response.headers.get("content-type") ?? "";
const outputType = ct.includes("application/json") ? "json"
                 : ct.includes("text/markdown") ? "markdown"
                 : "plain";
return { output, isError: false, outputType };
```

All 37 other tools: no change. Their results enter the heuristic path. This is correct:

- `GlobTool`, `LSTool`, `GrepTool` return path/match strings → heuristic falls through to plain (correct).
- `FileWriteTool`, `FileEditTool`, `MultiEditTool`, `NotebookEditTool` return diff/confirmation strings → plain (correct).
- `BashTool`, `PowerShellTool` return arbitrary command output → heuristic catches JSON/markdown if present (correct).
- `ImageReadTool` already uses `__IMAGE__:` sentinel → image branch wins before heuristic (correct).
- All `Task*Tool`, `Cron*Tool`, `Agent*Tool`, etc. → return JSON-ish or plain → heuristic handles (correct).
- All MCP tools (via `DeferredMcpTool`) → undefined `outputType`, heuristic detects (correct, pending v2.27+ MCP image work).

### Component 3 — `output-renderer.ts` (new)

**File:** `src/renderer/output-renderer.ts` (~80 lines)

```ts
import { isImageOutput, renderImageInline } from "./image.js";
import { renderJsonTree } from "./json-tree.js";
import { renderMarkdown } from "./markdown.js";
import type { CellGrid, Style } from "./cells.js";

type OutputType = "json" | "markdown" | "image" | "plain";

export function renderToolOutput(
  grid: CellGrid,
  row: number,
  col: number,
  output: string,
  outputType: OutputType | undefined,
  width: number,
  opts: { status: "running" | "done" | "error"; maxLines: number; limit: number },
): number {
  // Image sentinel always wins (preserves existing path).
  // Note: outputType === "image" is effectively dead — image content always uses
  // the sentinel format, so the sentinel check fires first. The "image" union
  // member exists for type-system completeness; if a tool stamps "image" without
  // emitting the sentinel, it falls through to renderPlain (defensive).
  if (isImageOutput(output)) {
    const label = renderImageInline(output);
    if (row >= opts.limit) return 0;
    grid.writeText(row, col, label.slice(0, width),
      { fg: null, bg: null, bold: false, dim: true, underline: false });
    return 1;
  }

  // Typed dispatch
  if (outputType === "json") {
    const parsed = tryParseJson(output);
    if (parsed.ok) return renderJsonTree(grid, row, col, parsed.value, width, opts);
    return renderPlain(grid, row, col, output, width, opts);
  }
  if (outputType === "markdown") {
    return renderMarkdown(grid, row, col, output, width, false, opts.limit);
  }
  if (outputType === "plain" || outputType === "image") {
    return renderPlain(grid, row, col, output, width, opts);
  }

  // Heuristic fallback (outputType undefined)
  const json = tryParseJson(output);
  if (json.ok) return renderJsonTree(grid, row, col, json.value, width, opts);
  if (looksLikeMarkdown(output)) {
    return renderMarkdown(grid, row, col, output, width, false, opts.limit);
  }
  return renderPlain(grid, row, col, output, width, opts);
}

export function tryParseJson(s: string): { ok: true; value: unknown } | { ok: false } {
  const t = s.trimStart();
  if (t[0] !== "{" && t[0] !== "[") return { ok: false };
  try { return { ok: true, value: JSON.parse(t) }; }
  catch { return { ok: false }; }
}

export function looksLikeMarkdown(s: string): boolean {
  if (/```[\w]*\n/.test(s)) return true;                       // fenced code block
  if (/^\|.+\|\s*\n\|[\s:|-]+\|/m.test(s)) return true;        // table header+separator
  const headingCount = (s.match(/^#{1,6}\s+\S/gm) ?? []).length;
  if (headingCount >= 2) return true;                          // ≥2 ATX headings
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
  // Mirrors existing inline behavior at layout-sections.ts:226-238 — kept here so
  // the dispatcher is the single integration point with renderToolCallsSection.
  const outLines = output.split("\n");
  const showLines = outLines.slice(0, opts.maxLines);
  let r = row;
  for (const line of showLines) {
    if (r >= opts.limit) break;
    const lineStyle: Style = opts.status === "error"
      ? { fg: "red", bg: null, bold: false, dim: false, underline: false }
      : { fg: null, bg: null, bold: false, dim: true, underline: false };
    grid.writeTextWithLinks(r, col, line.slice(0, width), lineStyle, col + width);
    r++;
  }
  if (outLines.length > opts.maxLines && r < opts.limit) {
    grid.writeText(r, col, `… (${outLines.length} lines total)`,
      { fg: null, bg: null, bold: false, dim: true, underline: false });
    r++;
  }
  return r - row;
}

// renderImageBranch was inlined into renderToolOutput above for clarity (5 lines).
```

**Conservative heuristics rationale:** false positives are worse than false negatives. A tool returning prose with a single `|` won't trigger markdown. A tool returning a JSON-shaped string mid-paragraph (e.g., `"Here's the result: {foo:bar}"`) won't trigger JSON parse because the trim-prefix check fails on the leading non-`{` character.

### Component 4 — `json-tree.ts` (new)

**File:** `src/renderer/json-tree.ts` (~140 lines)

```ts
export function renderJsonTree(
  grid: CellGrid,
  row: number,
  col: number,
  value: unknown,
  width: number,
  opts: { maxLines: number; limit: number },
): number;
```

**Color scheme** (theme-driven, reuses existing palette from `utils/theme-data.ts`):
- **Keys** → `t.user` (theme identifier color)
- **Strings** → `t.success` (green family)
- **Numbers / booleans / null** → `t.tool` (yellow family)
- **Punctuation** (`{`, `}`, `[`, `]`, `,`, `:`) → dim
- **Truncation markers** (`{…}`, `[N items]`, `… N more`) → dim

**Layout:**
- 2-space indent per nesting level.
- Object keys quoted: `"key": value`.
- One key/value or array entry per line.
- At depth > `maxDepth` (constant `3`), collapse: object → `{…}`, array → `[N items]`.
- At line count > `opts.maxLines` (caller passes `20`, matching the existing tool-output cap at `layout-sections.ts:227`), truncate with `… (N lines total)` footer (mirrors `layout-sections.ts:236`).

**Why `isExpanded` isn't an opt here:** the existing layout-sections.ts:219 `isExpanded` gate determines whether the output block renders *at all* (collapsed = no output shown, expanded = output shown with 20-line cap). That gate stays unchanged; `renderToolOutput` is only invoked when `isExpanded` is true. The renderer never sees the flag — it just respects the caller's `maxLines` cap.

**Circular reference safety:** maintain a `Set<unknown>` of seen objects during descent; on revisit emit `"[Circular]"` and stop. Prevents infinite recursion on tool outputs that round-trip through structured-clone-style serialization.

**No measurement function in v1.** Unlike `markdown.ts`'s `measureMarkdown`, JSON tree doesn't pre-measure for layout — it just respects the `limit` row passed in. Adding `measureJsonTree` if/when a future feature needs it (e.g., scrollable result panes).

### Component 5 — Wire into `layout-sections.ts`

Replace `src/renderer/layout-sections.ts:219-239` (the entire image-or-plain-output branch inside `renderToolCallsSection`):

```ts
// BEFORE (lines 219-239)
if (tc.output && tc.status !== "running" && isExpanded && r < limit) {
  if (isImageOutput(tc.output)) { /* ... */ continue; }
  const outLines = tc.output.split("\n");
  /* ... 13 lines of split+slice+per-line write ... */
}

// AFTER
if (tc.output && tc.status !== "running" && isExpanded && r < limit) {
  const consumed = renderToolOutput(grid, r, 6, tc.output, tc.outputType, w - 8, {
    status: tc.status,
    maxLines: 20,
    limit,
  });
  r += consumed;
}
```

`renderToolOutput` is now the single integration point — all four format branches live behind it.

## Data flow

```
Tool.call()                                          [src/Tool.ts]
   │ returns ToolResult { output, isError, outputType? }
   ▼
executeSingleTool()                                  [src/query/tools.ts]
   │ emits ToolCallEnd { ..., output, outputType? }
   ▼
REPL handleEvent() — tool_call_end branch            [src/repl.ts]
   │ tc.output = event.output
   │ tc.outputType = event.outputType    ← NEW
   ▼
LayoutState.toolCalls Map                            [src/renderer/layout.ts]
   │ ToolCallInfo carries outputType through
   ▼
renderToolCallsSection (per-frame)                   [src/renderer/layout-sections.ts]
   │ replaces 13-line branch with one call:
   │   r += renderToolOutput(grid, r, 6, tc.output, tc.outputType, w-8, {...})
   ▼
renderToolOutput dispatches                          [src/renderer/output-renderer.ts]
   │
   ├─ image sentinel  → renderImageInline            [existing, unchanged]
   ├─ outputType="json" or heuristic JSON
   │     → renderJsonTree                            [NEW]
   ├─ outputType="markdown" or heuristic markdown
   │     → renderMarkdown                            [existing, unchanged]
   └─ otherwise (plain or fallback)
         → renderPlain (split-and-write)             [moved from layout-sections.ts]
```

No new query events. No new state shape changes beyond the optional `outputType` hint.

## Error handling

| Failure | Behavior |
|---|---|
| `renderJsonTree` on circular reference | Emit `"[Circular]"`, stop descent |
| `renderJsonTree` exceeds `maxDepth` | Collapse: object → `{…}`, array → `[N items]` |
| `renderJsonTree` exceeds `maxLines` | Truncate with `… (N lines total)` footer |
| `tryParseJson` parse failure | Returns `{ ok: false }`. No throw, no warning |
| `outputType === "json"` but malformed JSON | Falls through to `renderPlain` (stamping bug shouldn't crash renderer) |
| `outputType === "image"` but no sentinel prefix | Falls through to `renderPlain` (defensive — don't try to re-encode) |
| All renderers | Respect `opts.limit` row; never write past max row given by caller |

## Testing

| File | Tests | Coverage |
|---|---|---|
| `src/renderer/json-tree.test.ts` (new) | 10 | primitives / nested object / nested array / depth>3 collapse / maxLines truncation / circular ref / non-object input / empty {} and [] / null and undefined / theme color application |
| `src/renderer/output-renderer.test.ts` (new) | 12 | typed dispatch (json/markdown/plain/image) × heuristic dispatch (each branch) × heuristic edge cases (prose with \|, JSON-shaped string in markdown, ≥2 headings) × image sentinel precedence × malformed-stamped-JSON fallback × "image" stamp without sentinel fallback |
| `src/tools/FileReadTool/index.test.ts` (extend) | 3 | `.json` extension stamps "json" / `.md` stamps "markdown" / `.txt` stamps "plain" |
| `src/tools/WebFetchTool/index.test.ts` (extend) | 2 | `application/json` Content-Type stamps "json" / `text/markdown` stamps "markdown" |
| `src/renderer/ui-ux.test.ts` (extend) | 4 | tool-call section renders JSON tree for typed JSON / renders markdown table for typed markdown / falls back to plain for typed "plain" / heuristic catches JSON when outputType undefined |
| Event propagation test | 1 | `ToolCallEnd` event with `outputType` field flows into `ToolCallInfo` via REPL handler |
| **Total** | **+32** | **1450/1450 expected (was 1418)** |

Snapshot tests use the existing cell-grid serialization helper in `ui-ux.test.ts`. All tests run against the public renderer API; no internal LayoutState manipulation beyond what existing tests already do.

## Build sequence

Single PR, ordered to keep each commit green:

1. **Type plumbing** — extend `Tool.ts:ToolResult`, `events.ts:ToolCallEnd`, `layout.ts:ToolCallInfo`, REPL handler. Build still passes (field is optional everywhere).
2. **JSON tree** — new `json-tree.ts` + `json-tree.test.ts`. Standalone; no wiring yet.
3. **Output dispatcher** — new `output-renderer.ts` + `output-renderer.test.ts`. Imports json-tree, image, markdown.
4. **Wire into layout-sections** — replace `layout-sections.ts:219-239` image-or-plain branch with `renderToolOutput` call. Extend `ui-ux.test.ts` with the 4 integration tests.
5. **Stamp FileReadTool + WebFetchTool** — add `outputType` to return values + extend each tool's test file.
6. **Run full suite** — `npm run typecheck && npm run lint && npm run test:cli`. Smoke `packages/sdk/test/smoke/smoke.mjs` for SDK regressions (none expected, pure renderer change + optional-field plumbing).

**Estimated PR size:** ~600 lines (300 source + 300 test). If reviewer feedback pushes for split, divide as PR1=plumbing+json-tree+dispatcher (no wiring), PR2=wiring+tool stamping. Same as v2.25.0 split protocol.

## Verification

- **JSON tree:** snapshot a tool-call section with output set to `'{"foo":[1,"two",null],"nested":{"a":1}}'` and `outputType: "json"`. Assert color cells for keys, strings, numbers, punctuation. Manual REPL: run `Read package.json`, observe colored tree.
- **Markdown dispatch:** snapshot a tool-call with markdown output containing a fenced code block. Assert syntax-highlighted code cells. Manual REPL: run `Read README.md`, observe rendered headings + code blocks.
- **Heuristic fallback:** snapshot a tool-call with `outputType` undefined and JSON-shaped output. Assert JSON tree path is taken.
- **Image sentinel precedence:** snapshot with `outputType: "json"` AND output starting with `__IMAGE__:`. Assert image branch wins (no JSON parse attempt).
- **Stamping bug fallback:** snapshot with `outputType: "json"` and output `"not actually json"`. Assert plain rendering, no crash.
- **Conservative markdown heuristic:** snapshot with output `"a | b | c"` (single bare line). Assert plain rendering — no false-positive table detection.
- **Build:** `npm run typecheck && npm run lint && npm run test:cli` — must be green.

## Release pattern

Standard from v2.21 / v2.22 / v2.23 / v2.24 / v2.25:
1. Merge the rich-tool-output PR.
2. Bump `package.json` to `2.26.0`. SDK unchanged this release.
3. Consolidate `Unreleased` → `## 2.26.0 (YYYY-MM-DD) — Rich Tool Output`. **Cross-check Unreleased against `git log v2.25.0..HEAD`** before tagging — the rebase-conflict-drops-Unreleased-entries pattern has hit twice in the last six releases.
4. Tag `v2.26.0`, push tag, npm publish via `publish.yml`.
5. Write `project_v2_26_0.md` memory entry; update `MEMORY.md` index.

After v2.26.0, only U-C5 (nested tool-call display) remains in the audit. U-C5 needs a query event-protocol RFC for `parentCallId` plumbing — not bundled here.

## Rollback

Pure additive change. `outputType` is optional everywhere; reverting the PR removes the field cleanly. No state-schema migration; no config-schema change; no LLM-visible behavior change (the model still sees only `output`). The two tools that stamp can revert their stamping line independently.

## Follow-ups (out of scope for v2.26.0)

1. **MCP image-content preservation** (~2 days) — refactor `src/mcp/client.ts:181-184` to preserve `content[]` entries with `type !== "text"`. Requires reconnect/retry handling for image bytes. Defer until a popular MCP server actually emits image content.
2. **Configurability** — opt-out flag, per-tool override, theme override for JSON-tree colors. Defer until users ask.
3. **`measureJsonTree`** — pre-measurement for scrollable result panes. Defer until a feature needs it.
4. **Stamp more built-in tools** — most don't benefit from explicit stamping over the heuristic. Stamp opportunistically as tools are touched for unrelated reasons.
