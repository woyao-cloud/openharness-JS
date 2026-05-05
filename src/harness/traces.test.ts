import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exportTraceOTLP, formatFlameGraph, formatTrace, SessionTracer, type TraceSpan } from "./traces.js";

describe("SessionTracer", () => {
  it("starts and ends spans", () => {
    const tracer = new SessionTracer("test-session");
    const spanId = tracer.startSpan("test_span", { tool: "Read" });
    const span = tracer.endSpan(spanId);
    assert.ok(span);
    assert.equal(span.name, "test_span");
    assert.equal(span.status, "ok");
    assert.ok(span.durationMs >= 0);
    assert.equal(span.attributes.tool, "Read");
  });

  it("tracks multiple spans", () => {
    const tracer = new SessionTracer("test-session");
    tracer.startSpan("span1");
    tracer.startSpan("span2");
    tracer.endSpan("span-1");
    tracer.endSpan("span-2");
    assert.equal(tracer.getSpans().length, 2);
  });

  it("supports parent-child relationships", () => {
    const tracer = new SessionTracer("test-session");
    const parent = tracer.startSpan("parent");
    const child = tracer.startSpan("child", {}, parent);
    tracer.endSpan(child);
    tracer.endSpan(parent);

    const spans = tracer.getSpans();
    const childSpan = spans.find((s) => s.name === "child");
    assert.ok(childSpan);
    assert.equal(childSpan.parentSpanId, parent);
  });

  it("records error status", () => {
    const tracer = new SessionTracer("test-session");
    const spanId = tracer.startSpan("failing");
    const span = tracer.endSpan(spanId, "error");
    assert.ok(span);
    assert.equal(span.status, "error");
  });

  it("returns null for unknown span ID", () => {
    const tracer = new SessionTracer("test-session");
    assert.equal(tracer.endSpan("nonexistent"), null);
  });

  it("getSummary returns correct stats", () => {
    const tracer = new SessionTracer("test-session");
    const s1 = tracer.startSpan("tool_call");
    tracer.endSpan(s1);
    const s2 = tracer.startSpan("tool_call");
    tracer.endSpan(s2);
    const s3 = tracer.startSpan("error_span");
    tracer.endSpan(s3, "error");

    const summary = tracer.getSummary();
    assert.equal(summary.totalSpans, 3);
    assert.equal(summary.errors, 1);
    assert.ok(summary.spansByName.tool_call);
    assert.equal(summary.spansByName.tool_call!.count, 2);
  });
});

describe("formatTrace", () => {
  it("formats empty trace", () => {
    assert.ok(formatTrace([]).includes("No trace"));
  });

  // (formatFlameGraph tests live in their own describe-block below.)

  it("formats spans with tree structure", () => {
    const spans = [
      {
        spanId: "s1",
        name: "query_turn",
        startTime: 1000,
        endTime: 2000,
        durationMs: 1000,
        attributes: {},
        status: "ok" as const,
      },
      {
        spanId: "s2",
        parentSpanId: "s1",
        name: "tool_call",
        startTime: 1100,
        endTime: 1500,
        durationMs: 400,
        attributes: { tool: "Read" },
        status: "ok" as const,
      },
    ];
    const output = formatTrace(spans);
    assert.ok(output.includes("query_turn"));
    assert.ok(output.includes("tool_call"));
    assert.ok(output.includes("1000ms"));
  });
});

describe("exportTraceOTLP", () => {
  it("exports in OpenTelemetry format", () => {
    const spans = [
      {
        spanId: "s1",
        name: "test",
        startTime: 1000,
        endTime: 2000,
        durationMs: 1000,
        attributes: { key: "value" },
        status: "ok" as const,
      },
    ];
    const otlp = exportTraceOTLP("test-session", spans) as any;
    assert.ok(otlp.resourceSpans);
    assert.equal(otlp.resourceSpans[0].scopeSpans[0].spans.length, 1);
    assert.equal(otlp.resourceSpans[0].scopeSpans[0].spans[0].name, "test");
  });

  it("emits valid hex-only IDs that OTLP collectors accept", () => {
    // Regression: previously traceId/spanId were `padEnd("0").slice(0, N)` of
    // raw inputs, leaving hyphens in UUIDs and the literal `-` and letters in
    // `"span-N"`. OTel Collector / Jaeger / Tempo validate hex encoding and
    // reject those, silently dropping every shipped span.
    const sessionId = "abc12345-6789-4def-89ab-0123456789ab"; // realistic UUID v4
    const spans = [
      {
        spanId: "span-1",
        name: "parent",
        startTime: 1000,
        endTime: 2000,
        durationMs: 1000,
        attributes: {},
        status: "ok" as const,
      },
      {
        spanId: "span-2",
        parentSpanId: "span-1",
        name: "child",
        startTime: 1100,
        endTime: 1900,
        durationMs: 800,
        attributes: {},
        status: "ok" as const,
      },
    ];
    const otlp = exportTraceOTLP(sessionId, spans) as any;
    const exported = otlp.resourceSpans[0].scopeSpans[0].spans;

    const HEX32 = /^[0-9a-f]{32}$/;
    const HEX16 = /^[0-9a-f]{16}$/;

    assert.match(exported[0].traceId, HEX32, "traceId must be 32 hex chars (no hyphens)");
    assert.match(exported[0].spanId, HEX16, "spanId must be 16 hex chars (no `-` or letters past f)");
    assert.match(exported[1].spanId, HEX16);
    assert.match(exported[1].parentSpanId, HEX16, "parentSpanId must also be hex-only");

    // Both spans share the same traceId (same session)
    assert.equal(exported[0].traceId, exported[1].traceId);

    // Child's parentSpanId must equal parent's spanId so the trace stitches together
    assert.equal(exported[1].parentSpanId, exported[0].spanId);

    // Different spanIds in the input must still produce different hex IDs
    assert.notEqual(exported[0].spanId, exported[1].spanId);
  });

  it("omits parentSpanId when the source span has no parent", () => {
    const otlp = exportTraceOTLP("session", [
      {
        spanId: "span-1",
        name: "root",
        startTime: 0,
        endTime: 1,
        durationMs: 1,
        attributes: {},
        status: "ok" as const,
      },
    ]) as any;
    const span = otlp.resourceSpans[0].scopeSpans[0].spans[0];
    assert.equal(span.parentSpanId, undefined);
  });
});

describe("SessionTracer OTLP shipping (C.3)", () => {
  it("POSTs each ended span to the configured OTLP endpoint", async () => {
    const captured: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      captured.push({
        url: String(url),
        body: init?.body ? JSON.parse(init.body as string) : null,
        headers: (init?.headers as Record<string, string>) ?? {},
      });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    try {
      const tracer = new SessionTracer("test-otlp", {
        endpoint: "http://localhost:4318/v1/traces",
        headers: { Authorization: "Bearer test-token" },
      });
      const spanId = tracer.startSpan("test_span", { tool: "Read" });
      tracer.endSpan(spanId);

      // fire-and-forget; give the microtask queue a tick to drain
      await new Promise((r) => setImmediate(r));

      assert.equal(captured.length, 1, "expected 1 POST per ended span");
      assert.equal(captured[0]!.url, "http://localhost:4318/v1/traces");
      assert.equal(captured[0]!.headers.Authorization, "Bearer test-token");
      assert.equal((captured[0]!.headers as any)["Content-Type"], "application/json");
      const otlp = captured[0]!.body as any;
      assert.ok(otlp.resourceSpans, "expected OTLP resourceSpans payload shape");
      assert.equal(otlp.resourceSpans[0].scopeSpans[0].spans[0].name, "test_span");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does NOT POST when no OTLP config is provided (default behaviour preserved)", async () => {
    let postCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      postCount++;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    try {
      const tracer = new SessionTracer("test-no-otlp");
      const spanId = tracer.startSpan("noop");
      tracer.endSpan(spanId);

      await new Promise((r) => setImmediate(r));
      assert.equal(postCount, 0, "no fetch should fire without OTLP config");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("coalesces many spans ending in the same tick into a single POST", async () => {
    // Regression: previously each endSpan fired its own fetch with no
    // backpressure — 100 spans = 100 concurrent in-flight requests. We now
    // microtask-debounce so spans ending in the same tick share a POST.
    const captured: Array<{ spanCount: number }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      const spans = body?.resourceSpans?.[0]?.scopeSpans?.[0]?.spans ?? [];
      captured.push({ spanCount: spans.length });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    try {
      const tracer = new SessionTracer("test-batch", {
        endpoint: "http://localhost:4318/v1/traces",
      });
      // End 25 spans synchronously in the same tick.
      for (let i = 0; i < 25; i++) {
        const id = tracer.startSpan(`tool_call_${i}`);
        tracer.endSpan(id);
      }
      // Microtask flush runs before setImmediate.
      await new Promise((r) => setImmediate(r));

      assert.equal(captured.length, 1, "25 spans in one tick should coalesce into 1 POST");
      assert.equal(captured[0]!.spanCount, 25, "the single batched POST should carry all 25 spans");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("flush() awaits in-flight POSTs (no spans dropped at session end)", async () => {
    // Regression: previously `endSpan` fired-and-forgot — process.exit
    // could land while a fetch was still on the wire, dropping the span.
    // flush() must await any in-flight POST before resolving.
    let fetchResolved = false;
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalls++;
      // Simulate a slow OTLP endpoint — resolve after one macrotask tick.
      await new Promise((r) => setImmediate(r));
      fetchResolved = true;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    try {
      const tracer = new SessionTracer("test-flush", {
        endpoint: "http://localhost:4318/v1/traces",
      });
      tracer.endSpan(tracer.startSpan("a"));
      // Don't yield — go straight into flush(). The microtask flush will
      // either have run (kicking off the fetch) or flush() drains the buffer
      // itself; either way flush() must await the resulting fetch.
      await tracer.flush();

      assert.equal(fetchCalls, 1, "exactly one POST should have been issued");
      assert.ok(fetchResolved, "flush() must await the in-flight POST before returning");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("flush() is a no-op when OTLP is not configured", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    try {
      const tracer = new SessionTracer("no-otlp");
      tracer.endSpan(tracer.startSpan("x"));
      await tracer.flush();
      assert.equal(fetchCount, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("swallows OTLP fetch errors so telemetry never crashes the agent", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("collector unreachable");
    }) as typeof fetch;

    try {
      const tracer = new SessionTracer("test-otlp-err", {
        endpoint: "http://invalid.example.com/v1/traces",
      });
      const spanId = tracer.startSpan("test");
      const span = tracer.endSpan(spanId);

      // Span persistence + return value should be unaffected
      assert.ok(span, "endSpan should still return the span");
      assert.equal(span.name, "test");

      await new Promise((r) => setImmediate(r));
      // No throw means the test passes — the .catch() in shipSpanOTLP swallowed the error
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("formatFlameGraph", () => {
  // Sample trace: query → 2 tool calls in sequence → query continues
  const sample: TraceSpan[] = [
    {
      spanId: "s1",
      name: "query",
      startTime: 1000,
      endTime: 5000,
      durationMs: 4000,
      attributes: {},
      status: "ok",
    },
    {
      spanId: "s2",
      parentSpanId: "s1",
      name: "tool:Read",
      startTime: 1100,
      endTime: 1500,
      durationMs: 400,
      attributes: { file: "foo.ts" },
      status: "ok",
    },
    {
      spanId: "s3",
      parentSpanId: "s1",
      name: "tool:Bash",
      startTime: 2000,
      endTime: 4500,
      durationMs: 2500,
      attributes: { command: "npm test" },
      status: "error",
    },
  ];

  it("returns a friendly message on empty input", () => {
    assert.equal(formatFlameGraph([]), "No trace spans recorded.");
  });

  it("renders each span as a row with its name and ms label (color disabled for assertions)", () => {
    const out = formatFlameGraph(sample, 80, { color: false });
    assert.ok(out.includes("query"), "query row should appear");
    assert.ok(out.includes("tool:Read"), "tool:Read row should appear");
    assert.ok(out.includes("tool:Bash"), "tool:Bash row should appear");
    assert.ok(out.includes("4000ms"), "query duration label");
    assert.ok(out.includes("400ms"), "Read duration label");
    assert.ok(out.includes("2500ms"), "Bash duration label");
  });

  it("indents children by depth so the parent/child structure is visible", () => {
    const out = formatFlameGraph(sample, 80, { color: false });
    // The query row has no leading spaces before its name; child rows are
    // indented at least 2 spaces. Find the line for each.
    const lines = out.split("\n");
    const queryLine = lines.find((l) => l.includes("query") && !l.includes("breakdown"));
    const readLine = lines.find((l) => l.trimStart().startsWith("tool:Read"));
    assert.ok(queryLine, "query row should be present");
    assert.ok(readLine, "tool:Read row should be present");
    const readLeadingSpaces = readLine!.length - readLine!.trimStart().length;
    assert.ok(readLeadingSpaces >= 2, `child row should be indented (got ${readLeadingSpaces} spaces)`);
  });

  it("includes a span breakdown section ranked by total time", () => {
    const out = formatFlameGraph(sample, 80, { color: false });
    assert.ok(out.includes("Span breakdown"), "breakdown header");
    // tool:Bash has the most total time (2500ms), so it should appear before
    // tool:Read in the breakdown section.
    const breakdownIdx = out.indexOf("Span breakdown");
    const bashInBreakdown = out.indexOf("tool:Bash", breakdownIdx);
    const readInBreakdown = out.indexOf("tool:Read", breakdownIdx);
    assert.ok(bashInBreakdown >= 0 && readInBreakdown >= 0);
    assert.ok(bashInBreakdown < readInBreakdown, "highest-cost span should rank first");
  });

  it("reports the error count in the footer when status: error spans exist", () => {
    const out = formatFlameGraph(sample, 80, { color: false });
    assert.ok(out.includes("3 spans"), "span count");
    assert.ok(out.includes("error"), "error count footer");
  });

  it("emits ANSI codes by default and suppresses them when color: false", () => {
    const colored = formatFlameGraph(sample, 80);
    const plain = formatFlameGraph(sample, 80, { color: false });
    assert.ok(colored.includes("\x1b["), "default output should contain ANSI escapes");
    assert.ok(!plain.includes("\x1b["), "color:false output should be ANSI-free");
  });

  it("handles a tight terminal width by using the minimum bar canvas (≥20 cols)", () => {
    // Even at a deliberately small `width` (e.g. 50), the renderer must
    // produce non-empty output rather than negative-padded garbage.
    const out = formatFlameGraph(sample, 50, { color: false });
    assert.ok(out.includes("query"));
    assert.ok(out.includes("4000ms"));
  });

  it("survives a malformed trace where a span references a nonexistent parent (no infinite loop)", () => {
    const orphaned: TraceSpan[] = [
      {
        spanId: "x",
        parentSpanId: "ghost",
        name: "stray",
        startTime: 0,
        endTime: 5,
        durationMs: 5,
        attributes: {},
        status: "ok",
      },
    ];
    const out = formatFlameGraph(orphaned, 80, { color: false });
    assert.ok(out.includes("stray"));
  });
});
