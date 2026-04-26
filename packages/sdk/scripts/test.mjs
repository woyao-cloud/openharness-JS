// Cross-platform test runner — node --test doesn't expand globs on Windows.
// Walks packages/sdk/test/ for *.test.ts files and hands them to tsx.
import { execSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function findTests(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "fixtures" || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...findTests(full));
    else if (entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const tests = findTests("test");
if (tests.length === 0) {
  console.error("no tests found under test/");
  process.exit(1);
}

const cmd = `tsx --test ${tests.map((f) => `"${f}"`).join(" ")}`;
execSync(cmd, { stdio: "inherit" });
