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

import type { CellGrid, Style } from "./cells.js";
import { isImageOutput, renderImageInline } from "./image.js";
import { renderJsonTree } from "./json-tree.js";
import { renderMarkdown } from "./markdown.js";

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
    if (parsed.ok)
      return renderJsonTree(grid, row, col, parsed.value, width, { maxLines: opts.maxLines, limit: opts.limit });
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

const FENCED_RE = /```[\w]*\r?\n/;
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
    grid.writeText(r, col, `… (${outLines.length} lines total)`.slice(0, width), S_DIM);
    r++;
  }
  return r - row;
}
