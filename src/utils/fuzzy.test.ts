import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fuzzyFilter, fuzzyScore } from "./fuzzy.js";

describe("fuzzyScore", () => {
  it("returns 0 for empty query", () => {
    assert.equal(fuzzyScore("", "anything"), 0);
  });

  it("returns null when query chars are not all present", () => {
    assert.equal(fuzzyScore("xyz", "model"), null);
  });

  it("returns null when chars are present but out of order", () => {
    // 'c' only appears at index 0 in "commit"; "oc" needs c after o.
    assert.equal(fuzzyScore("oc", "commit"), null);
  });

  it("scores a prefix higher than a non-prefix subsequence", () => {
    const prefix = fuzzyScore("git", "git")!;
    const sub = fuzzyScore("git", "logging-init")!;
    assert.ok(prefix > sub, `prefix ${prefix} should outscore subseq ${sub}`);
  });

  it("scores a contiguous match higher than a scattered one", () => {
    const cont = fuzzyScore("hel", "hello")!;
    const scat = fuzzyScore("hel", "h-e-l-p")!;
    assert.ok(cont !== null && scat !== null && cont > scat, `cont ${cont} > scat ${scat}`);
  });

  it("rewards word-boundary matches", () => {
    // 'pl' matches at start of 'plan' (boundary) vs middle of 'reapply'.
    const start = fuzzyScore("pl", "plan")!;
    const mid = fuzzyScore("pl", "reapply")!;
    assert.ok(start > mid);
  });

  it("is case-insensitive", () => {
    assert.equal(fuzzyScore("GIT", "git"), fuzzyScore("git", "GIT"));
  });
});

describe("fuzzyFilter", () => {
  const cmds = [
    { name: "agents", description: "list agents" },
    { name: "approve", description: "approve a pending tool" },
    { name: "git", description: "git operations" },
    { name: "git-status", description: "show git status" },
    { name: "permissions", description: "permission settings" },
    { name: "model", description: "switch model" },
  ];

  it("drops non-matches", () => {
    const out = fuzzyFilter("zzz", cmds);
    assert.equal(out.length, 0);
  });

  it("returns prefix match before subsequence match", () => {
    const out = fuzzyFilter("g", cmds);
    // 'git' and 'git-status' both have prefix bonus; 'agents' is a subseq match.
    const names = out.map((r) => r.entry.name);
    assert.ok(names.indexOf("git") < names.indexOf("agents"), names.join(","));
  });

  it("matches across non-adjacent characters", () => {
    const out = fuzzyFilter("gst", cmds);
    const names = out.map((r) => r.entry.name);
    assert.ok(names.includes("git-status"), `expected git-status, got ${names.join(",")}`);
  });

  it("orders best score first", () => {
    const out = fuzzyFilter("gi", cmds);
    assert.equal(out[0]!.entry.name, "git");
  });

  it("preserves input order for tied scores", () => {
    const sameScore = [
      { name: "alpha" },
      { name: "alphabet" }, // both get same prefix+subseq score for "alp"? no — 'alphabet' has lower span penalty
    ];
    // Construct a true tie: equal-length names and identical structure.
    const tied = [{ name: "abc" }, { name: "abd" }];
    const out = fuzzyFilter("ab", tied);
    assert.equal(out[0]!.entry.name, "abc");
    assert.equal(out[1]!.entry.name, "abd");
    void sameScore;
  });
});
