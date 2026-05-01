import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { FileReadTool } from "./index.js";

test("stamps outputType='json' when reading a .json file", async () => {
  const tmp = path.join(os.tmpdir(), `fr-${Date.now()}.json`);
  await fs.writeFile(tmp, '{"a":1}');
  try {
    const r = await FileReadTool.call({ file_path: tmp }, { workingDir: process.cwd() });
    assert.equal(r.outputType, "json");
  } finally {
    await fs.rm(tmp, { force: true });
  }
});

test("stamps outputType='markdown' when reading a .md file", async () => {
  const tmp = path.join(os.tmpdir(), `fr-${Date.now()}.md`);
  await fs.writeFile(tmp, "# Hello");
  try {
    const r = await FileReadTool.call({ file_path: tmp }, { workingDir: process.cwd() });
    assert.equal(r.outputType, "markdown");
  } finally {
    await fs.rm(tmp, { force: true });
  }
});

test("stamps outputType='plain' when reading a .txt file", async () => {
  const tmp = path.join(os.tmpdir(), `fr-${Date.now()}.txt`);
  await fs.writeFile(tmp, "hello");
  try {
    const r = await FileReadTool.call({ file_path: tmp }, { workingDir: process.cwd() });
    assert.equal(r.outputType, "plain");
  } finally {
    await fs.rm(tmp, { force: true });
  }
});
