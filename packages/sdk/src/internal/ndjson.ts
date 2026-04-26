/**
 * NDJSON line splitter. Buffers partial chunks across reads; tolerates
 * `\r\n` line endings and skips non-JSON lines (mirrors the Python
 * `query.py` line loop, which silently drops `JSONDecodeError`s).
 */

import type { Readable } from "node:stream";

export async function* splitNdjson(stream: Readable): AsyncGenerator<Readonly<Record<string, unknown>>, void, void> {
  let buf = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream as AsyncIterable<string>) {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const raw = buf.slice(0, idx).replace(/\r$/, "").trim();
      buf = buf.slice(idx + 1);
      if (!raw) continue;
      const parsed = tryParse(raw);
      if (parsed) yield parsed;
    }
  }
  const tail = buf.replace(/\r$/, "").trim();
  if (tail) {
    const parsed = tryParse(tail);
    if (parsed) yield parsed;
  }
}

function tryParse(line: string): Readonly<Record<string, unknown>> | null {
  try {
    const obj = JSON.parse(line);
    return obj && typeof obj === "object" && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
