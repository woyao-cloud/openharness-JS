import { strict as assert } from "node:assert";
import { Readable } from "node:stream";
import { describe, test } from "node:test";
import { splitNdjson } from "../src/internal/ndjson.js";

function streamFrom(chunks: string[]): Readable {
  return Readable.from(chunks);
}

async function collect(stream: Readable): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const obj of splitNdjson(stream)) out.push(obj);
  return out;
}

describe("splitNdjson", () => {
  test("yields one object per newline-delimited JSON line", async () => {
    const stream = streamFrom([
      JSON.stringify({ a: 1 }) + "\n",
      JSON.stringify({ b: 2 }) + "\n",
    ]);
    assert.deepEqual(await collect(stream), [{ a: 1 }, { b: 2 }]);
  });

  test("reassembles a JSON line split across multiple chunks", async () => {
    const payload = JSON.stringify({ type: "text", content: "hello" });
    const stream = streamFrom([payload.slice(0, 4), payload.slice(4, 12), payload.slice(12) + "\n"]);
    assert.deepEqual(await collect(stream), [{ type: "text", content: "hello" }]);
  });

  test("tolerates CRLF line endings", async () => {
    const stream = streamFrom([JSON.stringify({ a: 1 }) + "\r\n", JSON.stringify({ a: 2 }) + "\r\n"]);
    assert.deepEqual(await collect(stream), [{ a: 1 }, { a: 2 }]);
  });

  test("skips blank lines and non-JSON lines", async () => {
    const stream = streamFrom(["\n", "not json\n", JSON.stringify({ ok: true }) + "\n", "  \n"]);
    assert.deepEqual(await collect(stream), [{ ok: true }]);
  });

  test("flushes a final unterminated JSON line", async () => {
    const stream = streamFrom([JSON.stringify({ tail: 1 })]);
    assert.deepEqual(await collect(stream), [{ tail: 1 }]);
  });

  test("ignores top-level arrays and primitives", async () => {
    const stream = streamFrom(["[1,2,3]\n", "42\n", JSON.stringify({ kept: 1 }) + "\n"]);
    assert.deepEqual(await collect(stream), [{ kept: 1 }]);
  });
});
