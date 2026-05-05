/**
 * Session Traces — structured observability for agent sessions.
 *
 * Every query turn, tool call, LLM stream, and compression event
 * generates a trace span. Traces enable debugging, replay, and
 * performance analysis.
 *
 * Compatible with OpenTelemetry export format.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TRACE_DIR = join(homedir(), ".oh", "traces");

// ── Types ──

export type TraceSpan = {
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  attributes: Record<string, unknown>;
  status: "ok" | "error";
};

export type TraceEvent = {
  name: string;
  timestamp: number;
  attributes?: Record<string, unknown>;
};

// ── Tracer ──

const MAX_IN_MEMORY_SPANS = 1000;

export type OTLPConfig = {
  endpoint: string;
  headers?: Record<string, string>;
};

export class SessionTracer {
  private sessionId: string;
  private spans: TraceSpan[] = [];
  private activeSpans = new Map<
    string,
    { name: string; startTime: number; parentSpanId?: string; attributes: Record<string, unknown> }
  >();
  private spanCounter = 0;
  private otlp?: OTLPConfig;
  /**
   * Pending spans that have ended but not yet been POSTed to OTLP. Drained
   * by a microtask-debounced flush (one POST per microtask boundary even if
   * many spans end in the same tick) and by the public `flush()` method.
   */
  private otlpBuffer: TraceSpan[] = [];
  private otlpFlushScheduled = false;
  /** In-flight fetches so `flush()` can await any POSTs already on the wire. */
  private otlpInFlight = new Set<Promise<void>>();

  constructor(sessionId: string, otlp?: OTLPConfig) {
    this.sessionId = sessionId;
    this.otlp = otlp;
  }

  /** Start a new span. Returns the span ID. */
  startSpan(name: string, attributes: Record<string, unknown> = {}, parentSpanId?: string): string {
    const spanId = `span-${++this.spanCounter}`;
    this.activeSpans.set(spanId, { name, startTime: Date.now(), parentSpanId, attributes });
    return spanId;
  }

  /** End a span and record it. */
  endSpan(spanId: string, status: "ok" | "error" = "ok", extraAttributes?: Record<string, unknown>): TraceSpan | null {
    const active = this.activeSpans.get(spanId);
    if (!active) return null;

    this.activeSpans.delete(spanId);
    const endTime = Date.now();
    const span: TraceSpan = {
      spanId,
      parentSpanId: active.parentSpanId,
      name: active.name,
      startTime: active.startTime,
      endTime,
      durationMs: endTime - active.startTime,
      attributes: { ...active.attributes, ...extraAttributes },
      status,
    };

    this.spans.push(span);
    // Cap in-memory spans (durable source is on disk)
    if (this.spans.length > MAX_IN_MEMORY_SPANS) {
      this.spans = this.spans.slice(-MAX_IN_MEMORY_SPANS);
    }
    this.persistSpan(span);
    if (this.otlp) this.shipSpanOTLP(span);
    return span;
  }

  /**
   * Buffer the span for OTLP shipping. The actual POST is deferred to a
   * microtask so multiple spans ending in the same tick coalesce into a
   * single batch POST instead of one fetch each. Errors are swallowed —
   * telemetry must never crash the agent.
   */
  private shipSpanOTLP(span: TraceSpan): void {
    if (!this.otlp) return;
    this.otlpBuffer.push(span);
    if (this.otlpFlushScheduled) return;
    this.otlpFlushScheduled = true;
    queueMicrotask(() => {
      this.otlpFlushScheduled = false;
      this.drainOTLPBuffer();
    });
  }

  /** Send whatever is in `otlpBuffer` as a single fire-and-forget POST. The
   * returned promise is tracked in `otlpInFlight` so `flush()` can await it. */
  private drainOTLPBuffer(): void {
    if (!this.otlp || this.otlpBuffer.length === 0) return;
    const batch = this.otlpBuffer;
    this.otlpBuffer = [];
    const payload = exportTraceOTLP(this.sessionId, batch);
    const p: Promise<void> = fetch(this.otlp.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(this.otlp.headers ?? {}) },
      body: JSON.stringify(payload),
    }).then(
      () => undefined,
      () => undefined, // swallow — telemetry must not interfere with the agent
    );
    this.otlpInFlight.add(p);
    p.finally(() => {
      this.otlpInFlight.delete(p);
    });
  }

  /**
   * Drain any pending OTLP buffer and await every in-flight POST. Call this at
   * session end so spans aren't dropped on `process.exit`. No-op when OTLP is
   * not configured. Errors are swallowed (already, by `drainOTLPBuffer`).
   */
  async flush(): Promise<void> {
    if (!this.otlp) return;
    // Drain any not-yet-shipped buffer first; cancel pending microtask flush
    // (the buffer becomes empty so the microtask would no-op anyway, but
    // clearing the flag is explicit).
    this.otlpFlushScheduled = false;
    this.drainOTLPBuffer();
    // Wait for every fetch we've kicked off (microtask-shipped or just now).
    if (this.otlpInFlight.size > 0) {
      await Promise.allSettled(Array.from(this.otlpInFlight));
    }
  }

  /** Get all completed spans */
  getSpans(): TraceSpan[] {
    return [...this.spans];
  }

  /** Get a summary of the trace */
  getSummary(): {
    totalSpans: number;
    totalDurationMs: number;
    spansByName: Record<string, { count: number; totalMs: number }>;
    errors: number;
  } {
    const spansByName: Record<string, { count: number; totalMs: number }> = {};
    let errors = 0;
    let minStart = Infinity;
    let maxEnd = 0;

    for (const span of this.spans) {
      const entry = spansByName[span.name] ?? { count: 0, totalMs: 0 };
      entry.count++;
      entry.totalMs += span.durationMs;
      spansByName[span.name] = entry;

      if (span.status === "error") errors++;
      if (span.startTime < minStart) minStart = span.startTime;
      if (span.endTime > maxEnd) maxEnd = span.endTime;
    }

    return {
      totalSpans: this.spans.length,
      totalDurationMs: maxEnd > minStart ? maxEnd - minStart : 0,
      spansByName,
      errors,
    };
  }

  /** Persist a span to the trace file */
  private persistSpan(span: TraceSpan): void {
    try {
      mkdirSync(TRACE_DIR, { recursive: true });
      const file = join(TRACE_DIR, `${this.sessionId}.jsonl`);
      appendFileSync(file, `${JSON.stringify(span)}\n`);
    } catch {
      /* never crash on tracing failure */
    }
  }
}

// ── Trace Loading ──

/** Load trace spans for a session */
export function loadTrace(sessionId: string): TraceSpan[] {
  const file = join(TRACE_DIR, `${sessionId}.jsonl`);
  if (!existsSync(file)) return [];

  try {
    return readFileSync(file, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TraceSpan);
  } catch {
    return [];
  }
}

/** List all sessions with traces */
export function listTracedSessions(): string[] {
  if (!existsSync(TRACE_DIR)) return [];
  return readdirSync(TRACE_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.replace(".jsonl", ""));
}

/** Format trace for display */
export function formatTrace(spans: TraceSpan[]): string {
  if (spans.length === 0) return "No trace spans recorded.";

  const lines: string[] = [`Trace (${spans.length} spans):\n`];

  // Group by parent for tree display
  const roots = spans.filter((s) => !s.parentSpanId);
  const children = new Map<string, TraceSpan[]>();
  for (const s of spans) {
    if (s.parentSpanId) {
      const list = children.get(s.parentSpanId) ?? [];
      list.push(s);
      children.set(s.parentSpanId, list);
    }
  }

  function renderSpan(span: TraceSpan, indent: number): void {
    const status = span.status === "error" ? "✗" : "✓";
    const pad = "  ".repeat(indent);
    const attrs = Object.entries(span.attributes)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${String(v).slice(0, 30)}`)
      .join(" ");

    lines.push(`${pad}${status} ${span.name} (${span.durationMs}ms) ${attrs}`);

    const kids = children.get(span.spanId) ?? [];
    for (const kid of kids) renderSpan(kid, indent + 1);
  }

  for (const root of roots) renderSpan(root, 0);

  // Summary
  const totalMs = spans.reduce((sum, s) => sum + s.durationMs, 0);
  const errors = spans.filter((s) => s.status === "error").length;
  lines.push("");
  lines.push(`Total: ${spans.length} spans, ${totalMs}ms, ${errors} errors`);

  return lines.join("\n");
}

// ── Flame-graph rendering ──

/** ANSI 256 colors picked for distinguishability across span names. */
const FLAME_COLORS = [
  "\x1b[38;5;202m", // orange (query)
  "\x1b[38;5;39m", // light blue (tool:Read)
  "\x1b[38;5;208m", // bright orange (tool:Bash)
  "\x1b[38;5;105m", // purple (tool:Edit)
  "\x1b[38;5;118m", // green (tool:Glob/Grep)
  "\x1b[38;5;226m", // yellow (tool:Web*)
  "\x1b[38;5;213m", // pink (think tools)
  "\x1b[38;5;245m", // grey (other)
];
const ANSI_RESET = "\x1b[0m";
const ANSI_DIM = "\x1b[2m";
const ANSI_RED = "\x1b[38;5;196m";

function colorForSpan(name: string): string {
  // Stable hash so the same span name always lands the same color across renders.
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return FLAME_COLORS[hash % FLAME_COLORS.length]!;
}

/**
 * Render spans as a flame-graph (icicle-graph really — top-down by depth).
 * Each span gets one row: indent by tree depth, then a bar of `█` characters
 * positioned along a wall-time axis sized to `width` columns. Bars start at
 * the column corresponding to the span's `startTime` relative to the trace's
 * minimum startTime, and span as many columns as their `durationMs` requires
 * (minimum 1 column so even sub-millisecond spans are visible).
 *
 * Total trace duration sets the time-axis scale: a 5-second trace and a
 * 50-second trace both fit the same `width`, so the same view works at any
 * scale without scrolling. Per-span ms label appears to the right of the bar;
 * span name appears at the left, indented by parent depth.
 *
 * Errored spans (status: "error") render in red; others use a stable
 * per-name color so the same tool keeps the same color across the trace.
 *
 * The bottom row is a time ruler with ticks at 0ms, 25%, 50%, 75%, 100%.
 *
 * @param spans the spans to render — typically `loadTrace(sessionId)`
 * @param width target width in columns (defaults to terminal width or 100)
 * @param opts.color emit ANSI color codes (defaults to true; set false for tests)
 */
export function formatFlameGraph(
  spans: TraceSpan[],
  width: number = process.stdout.columns || 100,
  opts: { color?: boolean } = {},
): string {
  if (spans.length === 0) return "No trace spans recorded.";
  const useColor = opts.color !== false;
  const c = (style: string, text: string): string => (useColor ? `${style}${text}${ANSI_RESET}` : text);

  // Trace bounds — every other timestamp is relative to minStart.
  let minStart = Infinity;
  let maxEnd = 0;
  for (const s of spans) {
    if (s.startTime < minStart) minStart = s.startTime;
    if (s.endTime > maxEnd) maxEnd = s.endTime;
  }
  const totalMs = maxEnd > minStart ? maxEnd - minStart : 1;

  // Layout: name column gets up to 30 chars; ms label gets up to 10; the rest
  // is the bar canvas. We need at least ~20 cols of bar canvas to be useful.
  const NAME_WIDTH = 30;
  const MS_WIDTH = 10;
  const PADDING = 3; // spaces between sections
  const barWidth = Math.max(20, width - NAME_WIDTH - MS_WIDTH - PADDING);

  // Build the depth map by walking the parent chain (spans are typically in
  // start-order but we don't rely on it). Caps recursion to prevent infinite
  // loops on a malformed trace where parent references form a cycle.
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const depthOf = new Map<string, number>();
  function depth(span: TraceSpan, hops = 0): number {
    if (hops > 50) return hops;
    if (depthOf.has(span.spanId)) return depthOf.get(span.spanId)!;
    let d = 0;
    if (span.parentSpanId) {
      const parent = byId.get(span.parentSpanId);
      if (parent) d = depth(parent, hops + 1) + 1;
    }
    depthOf.set(span.spanId, d);
    return d;
  }
  for (const s of spans) depth(s);

  // Sort by start time, ties broken by depth (parents before children).
  const sorted = [...spans].sort(
    (a, b) => a.startTime - b.startTime || depthOf.get(a.spanId)! - depthOf.get(b.spanId)!,
  );

  const lines: string[] = [];
  for (const span of sorted) {
    const d = depthOf.get(span.spanId)!;
    const offset = Math.floor(((span.startTime - minStart) / totalMs) * barWidth);
    const length = Math.max(1, Math.floor((span.durationMs / totalMs) * barWidth));
    const indent = "  ".repeat(Math.min(d, 4)); // visual cap at 4 indent levels
    const name = `${indent}${span.name}`.padEnd(NAME_WIDTH).slice(0, NAME_WIDTH);
    const bar = " ".repeat(offset) + "█".repeat(Math.min(length, barWidth - offset));
    const paddedBar = bar.padEnd(barWidth);
    const color = span.status === "error" ? ANSI_RED : colorForSpan(span.name);
    const msLabel = `${span.durationMs}ms`.padStart(MS_WIDTH);
    lines.push(`${name}   ${c(color, paddedBar)} ${c(ANSI_DIM, msLabel)}`);
  }

  // Time ruler: 3-5 ticks depending on canvas width. We need ~8 columns per
  // tick to fit timestamp labels without overlap; choose count that fits.
  const tickCount = barWidth >= 50 ? 5 : barWidth >= 30 ? 3 : 2;
  const tickPcts: number[] = [];
  for (let i = 0; i < tickCount; i++) tickPcts.push(i / (tickCount - 1));
  const tickValues = tickPcts.map((pct) => `${Math.round(totalMs * pct)}ms`);
  const rulerLine = " ".repeat(NAME_WIDTH + 3) + buildTimeRuler(barWidth, tickValues);
  lines.push("");
  lines.push(c(ANSI_DIM, rulerLine));

  // Per-name summary: count + total ms, descending by total ms.
  const summary: Record<string, { count: number; totalMs: number }> = {};
  for (const s of spans) {
    const e = summary[s.name] ?? { count: 0, totalMs: 0 };
    e.count++;
    e.totalMs += s.durationMs;
    summary[s.name] = e;
  }
  const ranked = Object.entries(summary).sort((a, b) => b[1].totalMs - a[1].totalMs);
  lines.push("");
  lines.push(c(ANSI_DIM, "Span breakdown (top by total time):"));
  for (const [name, { count, totalMs: tms }] of ranked.slice(0, 10)) {
    const pct = totalMs > 0 ? Math.round((tms / totalMs) * 100) : 0;
    lines.push(
      `  ${c(colorForSpan(name), "█")} ${name.padEnd(28)} ${count.toString().padStart(4)}× ${tms.toString().padStart(6)}ms  ${pct}%`,
    );
  }

  const errors = spans.filter((s) => s.status === "error").length;
  lines.push("");
  lines.push(c(ANSI_DIM, `${spans.length} spans, ${totalMs}ms total${errors > 0 ? `, ${errors} error(s)` : ""}`));

  return lines.join("\n");
}

/**
 * Build a time ruler line of exactly `width` columns with N tick labels
 * distributed evenly. Strategy: anchor the last tick right-aligned to the
 * width, then place earlier ticks at their proportional positions while
 * truncating any label that would overlap the next tick (or the last
 * tick's reserved start). Produces a clean ruler at any (width × N).
 *
 * The last tick's right-anchor means the rightmost timestamp always lands
 * exactly at the canvas edge, matching where bars end.
 */
function buildTimeRuler(width: number, ticks: string[]): string {
  if (ticks.length === 0 || width <= 0) return "";
  const buf = new Array<string>(width).fill(" ");

  // Step 1: place last tick right-aligned. Its start column constrains all
  // earlier ticks (they must end before lastStart - 1 so there's a gap).
  const lastLabel = ticks[ticks.length - 1]!;
  const lastStart = Math.max(0, width - lastLabel.length);
  for (let j = 0; j < lastLabel.length && lastStart + j < width; j++) {
    buf[lastStart + j] = lastLabel[j]!;
  }

  // Step 2: place earlier ticks left-to-right. Each can occupy from its
  // proportional start column up to either the next tick's start (minus 1
  // for a separator space) or, for the second-to-last tick, lastStart - 1.
  for (let i = 0; i < ticks.length - 1; i++) {
    const label = ticks[i]!;
    const start = Math.round((i / (ticks.length - 1)) * (width - 1));
    const nextProportional = Math.round(((i + 1) / (ticks.length - 1)) * (width - 1));
    const isPenultimate = i === ticks.length - 2;
    const endExclusive = isPenultimate ? lastStart - 1 : nextProportional - 1;
    const maxLen = Math.max(0, endExclusive - start);
    const out = label.slice(0, maxLen);
    for (let j = 0; j < out.length; j++) buf[start + j] = out[j]!;
  }
  return buf.join("");
}

/**
 * Coerce an arbitrary string (UUID with hyphens, "span-N", etc.) into a fixed-length
 * lowercase hex string suitable for OTLP. OTLP collectors (Jaeger, Tempo, OTel
 * Collector) validate that traceId is 32 hex chars and spanId is 16 hex chars and
 * reject anything containing `-` or non-hex letters. We strip non-hex chars, then
 * pad-left with zeros (or truncate from the left) to the target length.
 */
function toHexId(input: string, length: 16 | 32): string {
  const hex = input.toLowerCase().replace(/[^0-9a-f]/g, "");
  if (hex.length === 0) return "0".repeat(length);
  return hex.length >= length ? hex.slice(0, length) : hex.padStart(length, "0");
}

/** Export trace in OpenTelemetry-compatible format */
export function exportTraceOTLP(sessionId: string, spans: TraceSpan[]): object {
  const traceId = toHexId(sessionId, 32);
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "openharness" } },
            { key: "session.id", value: { stringValue: sessionId } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "openharness.agent" },
            spans: spans.map((s) => ({
              traceId,
              spanId: toHexId(s.spanId, 16),
              parentSpanId: s.parentSpanId ? toHexId(s.parentSpanId, 16) : undefined,
              name: s.name,
              startTimeUnixNano: s.startTime * 1_000_000,
              endTimeUnixNano: s.endTime * 1_000_000,
              attributes: Object.entries(s.attributes).map(([k, v]) => ({
                key: k,
                value: { stringValue: String(v) },
              })),
              status: { code: s.status === "ok" ? 1 : 2 },
            })),
          },
        ],
      },
    ],
  };
}
