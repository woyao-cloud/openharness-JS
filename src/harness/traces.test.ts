import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exportTraceOTLP, formatTrace, SessionTracer } from "./traces.js";

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
