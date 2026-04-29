import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CellGrid, EMPTY_STYLE } from "./cells.js";
import { diff } from "./differ.js";

const OSC8_OPEN = (url: string) => `\x1b]8;;${url}\x1b\\`;
const OSC8_CLOSE = "\x1b]8;;\x1b\\";

describe("differ OSC 8 hyperlinks", () => {
  it("emits OSC 8 open before linked cells and close after", () => {
    const prev = new CellGrid(20, 1);
    const next = new CellGrid(20, 1);
    next.writeTextWithLinks(0, 0, "https://x.example", EMPTY_STYLE);
    const out = diff(prev, next);
    assert.ok(out.includes(OSC8_OPEN("https://x.example")), "missing OSC 8 open");
    assert.ok(out.includes(OSC8_CLOSE), "missing OSC 8 close");
    // Open must precede first link char in output
    const openIdx = out.indexOf(OSC8_OPEN("https://x.example"));
    const charIdx = out.indexOf("h", openIdx);
    assert.ok(openIdx >= 0 && charIdx > openIdx, "open should precede char");
  });

  it("does not emit OSC 8 when no hyperlinks are present", () => {
    const prev = new CellGrid(10, 1);
    const next = new CellGrid(10, 1);
    next.writeText(0, 0, "hello", EMPTY_STYLE);
    const out = diff(prev, next);
    assert.ok(!out.includes("\x1b]8;;"), `should not emit OSC 8: ${JSON.stringify(out)}`);
  });

  it("coalesces a single open across adjacent same-URL cells", () => {
    const prev = new CellGrid(20, 1);
    const next = new CellGrid(20, 1);
    next.writeTextWithLinks(0, 0, "https://x.example", EMPTY_STYLE);
    const out = diff(prev, next);
    const opens = out.match(/\x1b\]8;;https:\/\/x\.example\x1b\\/g) ?? [];
    assert.equal(opens.length, 1, "should open the URL exactly once");
  });

  it("closes one URL and opens the next when adjacent", () => {
    const prev = new CellGrid(40, 1);
    const next = new CellGrid(40, 1);
    next.writeTextWithLinks(0, 0, "https://a.example https://b.example", EMPTY_STYLE);
    const out = diff(prev, next);
    assert.ok(out.includes(OSC8_OPEN("https://a.example")));
    assert.ok(out.includes(OSC8_OPEN("https://b.example")));
    // The space between is a non-linked cell; it should produce a close before the second open
    const aOpenIdx = out.indexOf(OSC8_OPEN("https://a.example"));
    const bOpenIdx = out.indexOf(OSC8_OPEN("https://b.example"));
    const closeBetween = out.indexOf(OSC8_CLOSE, aOpenIdx);
    assert.ok(closeBetween > aOpenIdx && closeBetween < bOpenIdx, "should close before next URL opens");
  });

  it("closes any open hyperlink at end of diff output", () => {
    const prev = new CellGrid(20, 1);
    const next = new CellGrid(20, 1);
    next.writeTextWithLinks(0, 0, "https://x.example", EMPTY_STYLE);
    const out = diff(prev, next);
    // Last OSC 8 sequence must be a close (before the trailing SGR reset)
    const lastOsc = out.lastIndexOf("\x1b]8;;");
    const sliced = out.slice(lastOsc);
    assert.ok(sliced.startsWith(OSC8_CLOSE), `tail should start with OSC 8 close, got: ${JSON.stringify(sliced)}`);
  });
});
