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
    assert.match(gridToText(grid, 0, 4), /\{\n {2}"a": 1,\n {2}"b": "hi"\n\}/);
  });

  it("renders a flat array on multiple lines", () => {
    const grid = new CellGrid(80, 10);
    const consumed = renderJsonTree(grid, 0, 0, [1, 2, "three"], 80, { maxLines: 20, limit: 10 });
    assert.equal(consumed, 5);
    assert.match(gridToText(grid, 0, 5), /\[\n {2}1,\n {2}2,\n {2}"three"\n\]/);
  });

  it("renders nested objects with indentation", () => {
    const grid = new CellGrid(80, 20);
    const consumed = renderJsonTree(grid, 0, 0, { outer: { inner: 1 } }, 80, { maxLines: 20, limit: 20 });
    const text = gridToText(grid, 0, consumed);
    assert.match(text, /"outer": \{/);
    assert.match(text, / {2}"inner": 1/);
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
    // arr is at depth 3 (a=1, b=2, arr=3), so it collapses to [5 items]
    const deep = { a: { b: { arr: [1, 2, 3, 4, 5] } } };
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
    obj.self = obj;
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

  it("renders circular reference inline with key, not as opener+circular+closer", () => {
    const grid = new CellGrid(80, 20);
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    const consumed = renderJsonTree(grid, 0, 0, obj, 80, { maxLines: 20, limit: 20 });
    // Expected output (4 lines):
    //   {
    //     "a": 1,
    //     "self": [Circular]
    //   }
    assert.equal(consumed, 4, `expected 4 rows for inline-circular form, got ${consumed}`);
    // Confirm "self" key and [Circular] are on the same row by checking text:
    const text = (() => {
      const lines: string[] = [];
      for (let r = 0; r < consumed; r++) {
        let line = "";
        for (let c = 0; c < grid.width; c++) line += grid.cells[r]![c]!.char;
        lines.push(line.replace(/\s+$/, ""));
      }
      return lines.join("\n");
    })();
    assert.match(text, /"self": \[Circular\]/);
  });
});
