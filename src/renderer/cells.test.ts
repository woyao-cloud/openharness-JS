import assert from "node:assert";
import { describe, it } from "node:test";
import { CellGrid, cellsEqual, EMPTY_STYLE } from "./cells.js";

describe("CellGrid", () => {
  it("initializes with spaces", () => {
    const grid = new CellGrid(10, 5);
    assert.strictEqual(grid.width, 10);
    assert.strictEqual(grid.height, 5);
    assert.strictEqual(grid.cells[0]![0]!.char, " ");
  });

  it("setCell writes a character with style", () => {
    const grid = new CellGrid(10, 5);
    grid.setCell(0, 0, "A", { fg: "red", bg: null, bold: true, dim: false, underline: false });
    assert.strictEqual(grid.cells[0]![0]!.char, "A");
    assert.strictEqual(grid.cells[0]![0]!.style.fg, "red");
    assert.strictEqual(grid.cells[0]![0]!.style.bold, true);
  });

  it("setCell ignores out-of-bounds", () => {
    const grid = new CellGrid(5, 5);
    grid.setCell(-1, 0, "X", EMPTY_STYLE);
    grid.setCell(0, 10, "X", EMPTY_STYLE);
    // Should not throw
    assert.strictEqual(grid.cells[0]![0]!.char, " ");
  });

  it("writeText handles newlines", () => {
    const grid = new CellGrid(20, 5);
    const rows = grid.writeText(0, 0, "ab\ncd", EMPTY_STYLE);
    assert.strictEqual(rows, 2);
    assert.strictEqual(grid.cells[0]![0]!.char, "a");
    assert.strictEqual(grid.cells[1]![0]!.char, "c");
  });

  it("writeWrapped wraps long words", () => {
    const grid = new CellGrid(10, 5);
    const rows = grid.writeWrapped(0, 0, "hello world foo", EMPTY_STYLE, 10);
    assert.ok(rows >= 2, `expected >= 2 rows, got ${rows}`);
  });

  it("clear resets all cells", () => {
    const grid = new CellGrid(5, 5);
    grid.setCell(0, 0, "X", { fg: "red", bg: null, bold: true, dim: false, underline: false });
    grid.clear();
    assert.strictEqual(grid.cells[0]![0]!.char, " ");
  });

  it("clone produces an independent copy", () => {
    const grid = new CellGrid(5, 5);
    grid.setCell(0, 0, "A", EMPTY_STYLE);
    const clone = grid.clone();
    clone.setCell(0, 0, "B", EMPTY_STYLE);
    assert.strictEqual(grid.cells[0]![0]!.char, "A");
    assert.strictEqual(clone.cells[0]![0]!.char, "B");
  });
});

describe("cellsEqual", () => {
  it("returns true for identical cells", () => {
    const a = { char: "A", style: { ...EMPTY_STYLE } };
    const b = { char: "A", style: { ...EMPTY_STYLE } };
    assert.strictEqual(cellsEqual(a, b), true);
  });

  it("returns false for different chars", () => {
    const a = { char: "A", style: { ...EMPTY_STYLE } };
    const b = { char: "B", style: { ...EMPTY_STYLE } };
    assert.strictEqual(cellsEqual(a, b), false);
  });

  it("returns false for different underline", () => {
    const a = { char: "A", style: { ...EMPTY_STYLE, underline: false } };
    const b = { char: "A", style: { ...EMPTY_STYLE, underline: true } };
    assert.strictEqual(cellsEqual(a, b), false);
  });

  it("returns false for different hyperlink", () => {
    const a = { char: "A", style: { ...EMPTY_STYLE, hyperlink: "https://a.example" } };
    const b = { char: "A", style: { ...EMPTY_STYLE, hyperlink: "https://b.example" } };
    assert.strictEqual(cellsEqual(a, b), false);
  });

  it("treats undefined and null hyperlink as equal", () => {
    const a = { char: "A", style: { ...EMPTY_STYLE, hyperlink: null } };
    const b = { char: "A", style: { ...EMPTY_STYLE, hyperlink: undefined } };
    assert.strictEqual(cellsEqual(a, b), true);
  });
});

describe("CellGrid.writeTextWithLinks", () => {
  it("tags http(s):// runs with hyperlink + cyan + underline", () => {
    const grid = new CellGrid(80, 1);
    grid.writeTextWithLinks(0, 0, "see https://example.com now", EMPTY_STYLE);
    // 'h' of https://example.com starts at col 4
    const linkCell = grid.cells[0]![4]!;
    assert.strictEqual(linkCell.char, "h");
    assert.strictEqual(linkCell.style.hyperlink, "https://example.com");
    assert.strictEqual(linkCell.style.fg, "cyan");
    assert.strictEqual(linkCell.style.underline, true);

    // surrounding 'see ' and ' now' are NOT linked
    assert.strictEqual(grid.cells[0]![0]!.style.hyperlink ?? null, null);
    const lastUrlChar = grid.cells[0]![4 + "https://example.com".length - 1]!;
    assert.strictEqual(lastUrlChar.style.hyperlink, "https://example.com");
    const afterUrl = grid.cells[0]![4 + "https://example.com".length]!;
    assert.strictEqual(afterUrl.style.hyperlink ?? null, null);
  });

  it("strips trailing punctuation from URL", () => {
    const grid = new CellGrid(80, 1);
    grid.writeTextWithLinks(0, 0, "see https://example.com.", EMPTY_STYLE);
    // The trailing '.' should NOT be part of the link
    const dotCell = grid.cells[0]![4 + "https://example.com.".length - 1]!;
    assert.strictEqual(dotCell.char, ".");
    assert.strictEqual(dotCell.style.hyperlink ?? null, null);
  });

  it("tags file:// URLs", () => {
    const grid = new CellGrid(80, 1);
    grid.writeTextWithLinks(0, 0, "open file:///tmp/foo.log please", EMPTY_STYLE);
    const linkCell = grid.cells[0]![5]!;
    assert.strictEqual(linkCell.style.hyperlink, "file:///tmp/foo.log");
  });

  it("does not exceed maxCol", () => {
    const grid = new CellGrid(80, 1);
    grid.writeTextWithLinks(0, 0, "https://very-long-url.example.com/path", EMPTY_STYLE, 10);
    // Only first 10 cols should be written; col 10+ stays default
    assert.strictEqual(grid.cells[0]![10]!.char, " ");
  });
});
