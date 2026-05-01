/**
 * Static JSON tree renderer for tool output.
 * Theme-colored, indented, depth-truncated, line-truncated.
 */

import { getTheme } from "../utils/theme-data.js";
import type { CellGrid, Style } from "./cells.js";

const s = (fg: string | null, bold = false, dim = false): Style => ({ fg, bg: null, bold, dim, underline: false });

const MAX_DEPTH = 3;

let S_KEY: Style;
let S_STRING: Style;
let S_NUMBER: Style;
let S_PUNCT: Style;
let S_TRUNC: Style;
let _stylesInit = false;

export function resetJsonStyleCache() {
  _stylesInit = false;
}

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
  if (value === null) {
    out.push({ indent, tokens: [{ text: "null", style: S_NUMBER }] });
    return;
  }
  if (typeof value === "string") {
    out.push({ indent, tokens: [{ text: JSON.stringify(value), style: S_STRING }] });
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    out.push({ indent, tokens: [{ text: String(value), style: S_NUMBER }] });
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push({ indent, tokens: [{ text: "[]", style: S_PUNCT }] });
      return;
    }
    if (depth >= MAX_DEPTH) {
      out.push({ indent, tokens: [{ text: `[${value.length} items]`, style: S_TRUNC }] });
      return;
    }
    if (seen.has(value)) {
      out.push({ indent, tokens: [{ text: "[Circular]", style: S_TRUNC }] });
      return;
    }
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
    if (entries.length === 0) {
      out.push({ indent, tokens: [{ text: "{}", style: S_PUNCT }] });
      return;
    }
    if (depth >= MAX_DEPTH) {
      out.push({ indent, tokens: [{ text: "{…}", style: S_TRUNC }] });
      return;
    }
    if (seen.has(value)) {
      out.push({ indent, tokens: [{ text: "[Circular]", style: S_TRUNC }] });
      return;
    }
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

  // Circular reference: render inline, no descent.
  if (seen.has(value)) {
    const circ: Token[] = [keyTok, colonTok, { text: "[Circular]", style: S_TRUNC }];
    if (trailingComma) circ.push({ text: ",", style: S_PUNCT });
    out.push({ indent, tokens: circ });
    return;
  }

  // Non-empty container: open bracket on key line, body indented, close bracket on its own line.
  const opener = Array.isArray(value) ? "[" : "{";
  const closer = Array.isArray(value) ? "]" : "}";
  out.push({ indent, tokens: [keyTok, colonTok, { text: opener, style: S_PUNCT }] });

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

  const closerTokens: Token[] = [{ text: closer, style: S_PUNCT }];
  if (trailingComma) closerTokens.push({ text: ",", style: S_PUNCT });
  out.push({ indent, tokens: closerTokens });
}
