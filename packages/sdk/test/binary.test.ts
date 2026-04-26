import { strict as assert } from "node:assert";
import path from "node:path";
import process from "node:process";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { OhBinaryNotFoundError } from "../src/errors.js";
import { findOhBinary } from "../src/internal/binary.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("findOhBinary", () => {
  test("respects an explicit override pointing at a script — prepends node", () => {
    const shim = path.join(__dirname, "fixtures", "oh-shim.cjs");
    const handle = findOhBinary(shim);
    assert.equal(handle.command, process.execPath);
    assert.deepEqual(handle.prefixArgs, [shim]);
  });

  test("uses OH_BINARY env var when no override is provided", () => {
    const shim = path.join(__dirname, "fixtures", "oh-shim.cjs");
    const previous = process.env.OH_BINARY;
    process.env.OH_BINARY = shim;
    try {
      const handle = findOhBinary();
      assert.equal(handle.command, process.execPath);
      assert.deepEqual(handle.prefixArgs, [shim]);
    } finally {
      if (previous === undefined) delete process.env.OH_BINARY;
      else process.env.OH_BINARY = previous;
    }
  });

  test("throws OhBinaryNotFoundError when override path does not exist", () => {
    const previous = process.env.OH_BINARY;
    delete process.env.OH_BINARY;
    const previousPath = process.env.PATH;
    process.env.PATH = path.join(__dirname, "no-such-dir");
    try {
      assert.throws(() => findOhBinary("/no/such/binary"), OhBinaryNotFoundError);
    } finally {
      if (previous !== undefined) process.env.OH_BINARY = previous;
      if (previousPath !== undefined) process.env.PATH = previousPath;
      else delete process.env.PATH;
    }
  });

  test("returns the candidate verbatim when it lacks a script extension", () => {
    // Use this very file's interpreter as a stand-in for a real native binary.
    const handle = findOhBinary(process.execPath);
    assert.equal(handle.command, process.execPath);
    assert.deepEqual(handle.prefixArgs, []);
  });
});
