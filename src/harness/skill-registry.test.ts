import assert from "node:assert/strict";
import test from "node:test";
import { type Registry, searchRegistry } from "./skill-registry.js";

const TEST_REGISTRY: Registry = {
  skills: [
    {
      name: "deploy",
      description: "Deploy app to production",
      author: "a",
      version: "1",
      source: "",
      tags: ["deploy", "vercel"],
    },
    {
      name: "test",
      description: "Run tests",
      author: "a",
      version: "1",
      source: "",
      tags: ["test", "jest"],
    },
  ],
};

test("searchRegistry filters by name", () => {
  const results = searchRegistry(TEST_REGISTRY, "deploy");
  assert.equal(results.length, 1);
  assert.equal(results[0].name, "deploy");
});

test("searchRegistry filters by tag", () => {
  const results = searchRegistry(TEST_REGISTRY, "vercel");
  assert.equal(results.length, 1);
  assert.equal(results[0].name, "deploy");
});

test("searchRegistry filters by description", () => {
  const results = searchRegistry(TEST_REGISTRY, "production");
  assert.equal(results.length, 1);
  assert.equal(results[0].name, "deploy");
});

test("searchRegistry is case-insensitive", () => {
  const results = searchRegistry(TEST_REGISTRY, "DEPLOY");
  assert.equal(results.length, 1);
  assert.equal(results[0].name, "deploy");
});

test("searchRegistry returns empty array when no match", () => {
  const results = searchRegistry(TEST_REGISTRY, "zzznomatch");
  assert.equal(results.length, 0);
});

test("searchRegistry returns all matching skills", () => {
  const results = searchRegistry(TEST_REGISTRY, "a");
  // Both have "a" in author, but searchRegistry searches name/description/tags
  // "deploy app" matches "a" in description, so at least deploy
  assert.ok(results.length >= 1);
});
