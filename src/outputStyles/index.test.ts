import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { makeTmpDir } from "../test-helpers.js";
import { BUILTIN_STYLES, DEFAULT_STYLE, loadOutputStyle, resolveStyleName } from "./index.js";

describe("BUILTIN_STYLES", () => {
  it("includes default, explanatory, and learning", () => {
    const names = BUILTIN_STYLES.map((s) => s.name);
    assert.ok(names.includes("default"));
    assert.ok(names.includes("explanatory"));
    assert.ok(names.includes("learning"));
  });

  it("DEFAULT_STYLE has an empty prompt (no preface)", () => {
    assert.equal(DEFAULT_STYLE.prompt, "");
  });

  it("explanatory style mentions insights", () => {
    const style = BUILTIN_STYLES.find((s) => s.name === "explanatory")!;
    assert.match(style.prompt, /Insights|insight/i);
  });

  it("learning style mentions TODO(human)", () => {
    const style = BUILTIN_STYLES.find((s) => s.name === "learning")!;
    assert.match(style.prompt, /TODO\(human\)/);
  });
});

describe("resolveStyleName", () => {
  it("falls back to default when name is undefined or empty", () => {
    assert.equal(resolveStyleName(undefined), "default");
    assert.equal(resolveStyleName(""), "default");
    assert.equal(resolveStyleName("   "), "default");
  });

  it("passes through a provided name lowercase-normalized", () => {
    assert.equal(resolveStyleName("Explanatory"), "explanatory");
    assert.equal(resolveStyleName("LEARNING"), "learning");
    assert.equal(resolveStyleName("  code-review  "), "code-review");
  });
});

describe("loadOutputStyle", () => {
  let tmp: string;
  let userHome: string;

  beforeEach(() => {
    tmp = makeTmpDir();
    userHome = makeTmpDir();
  });

  it("returns the default built-in when name is undefined", () => {
    const style = loadOutputStyle(undefined, { projectRoot: tmp, userHome });
    assert.equal(style.name, "default");
    assert.equal(style.prompt, "");
  });

  it("returns a matching built-in by name", () => {
    const style = loadOutputStyle("explanatory", { projectRoot: tmp, userHome });
    assert.equal(style.name, "explanatory");
    assert.match(style.prompt, /Insights|insight/i);
  });

  it("falls back to default when the name does not match any built-in or file", () => {
    const style = loadOutputStyle("does-not-exist", { projectRoot: tmp, userHome });
    assert.equal(style.name, "default");
  });

  it("loads a custom project-level style from .oh/output-styles/<name>.md", () => {
    const dir = join(tmp, ".oh", "output-styles");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "code-review.md"),
      "---\nname: code-review\ndescription: Focused code review mode\n---\n\nReview the code rigorously for bugs.",
    );
    const style = loadOutputStyle("code-review", { projectRoot: tmp, userHome });
    assert.equal(style.name, "code-review");
    assert.match(style.prompt, /Review the code rigorously/);
    assert.equal(style.description, "Focused code review mode");
  });

  it("loads a custom user-level style from ~/.oh/output-styles/<name>.md", () => {
    const dir = join(userHome, ".oh", "output-styles");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "terse.md"), "---\nname: terse\n---\n\nBe extremely terse.");
    const style = loadOutputStyle("terse", { projectRoot: tmp, userHome });
    assert.equal(style.name, "terse");
    assert.match(style.prompt, /Be extremely terse/);
  });

  it("project-level style shadows a user-level style with the same name", () => {
    const projectDir = join(tmp, ".oh", "output-styles");
    const userDir = join(userHome, ".oh", "output-styles");
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(projectDir, "shared.md"), "---\nname: shared\n---\n\nPROJECT version");
    writeFileSync(join(userDir, "shared.md"), "---\nname: shared\n---\n\nUSER version");
    const style = loadOutputStyle("shared", { projectRoot: tmp, userHome });
    assert.match(style.prompt, /PROJECT version/);
    assert.doesNotMatch(style.prompt, /USER version/);
  });

  it("custom style shadows a built-in of the same name", () => {
    const dir = join(tmp, ".oh", "output-styles");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "explanatory.md"),
      "---\nname: explanatory\n---\n\nCustom override of the built-in explanatory style.",
    );
    const style = loadOutputStyle("explanatory", { projectRoot: tmp, userHome });
    assert.match(style.prompt, /Custom override/);
  });

  it("is case-insensitive on the resolved name", () => {
    const style = loadOutputStyle("EXPLANATORY", { projectRoot: tmp, userHome });
    assert.equal(style.name, "explanatory");
  });

  it("trims leading/trailing whitespace from the prompt body", () => {
    const dir = join(tmp, ".oh", "output-styles");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "x.md"), "---\nname: x\n---\n\n\n  body text  \n\n");
    const style = loadOutputStyle("x", { projectRoot: tmp, userHome });
    assert.equal(style.prompt, "body text");
  });

  it("handles a file with no frontmatter (treats whole content as prompt)", () => {
    const dir = join(tmp, ".oh", "output-styles");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "raw.md"), "No frontmatter here, just prose.");
    const style = loadOutputStyle("raw", { projectRoot: tmp, userHome });
    assert.equal(style.name, "raw");
    assert.match(style.prompt, /No frontmatter here/);
  });

  it("falls back to default when a custom style file has malformed frontmatter", () => {
    const dir = join(tmp, ".oh", "output-styles");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "broken.md"), "---\nname: [broken, [unclosed\n---\n\nbody");
    const style = loadOutputStyle("broken", { projectRoot: tmp, userHome });
    // Either the file loads with raw content or we fall back silently — either way, must not throw
    assert.ok(style.name === "broken" || style.name === "default");
  });
});
