import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { languageToPrompt } from "./language.js";

describe("languageToPrompt", () => {
  it("returns empty string when language is undefined", () => {
    assert.strictEqual(languageToPrompt(undefined), "");
  });

  it("returns empty string when language is an empty string", () => {
    assert.strictEqual(languageToPrompt(""), "");
  });

  it("returns empty string when language is whitespace only", () => {
    assert.strictEqual(languageToPrompt("   "), "");
  });

  it("includes the language name in the directive", () => {
    const out = languageToPrompt("zh-CN");
    assert.match(out, /zh-CN/);
  });

  it("instructs the model to respond in the target language", () => {
    const out = languageToPrompt("Japanese");
    assert.match(out, /respond/i);
    assert.match(out, /Japanese/);
  });

  it("notes that code, commands, and file paths stay in their original language", () => {
    const out = languageToPrompt("zh-CN");
    assert.match(out, /code/i);
    assert.match(out, /command|path/i);
  });

  it("trims leading and trailing whitespace in the language value", () => {
    const out = languageToPrompt("  Spanish  ");
    assert.match(out, /Spanish/);
    assert.doesNotMatch(out, / {2}Spanish/);
  });

  it("works for common BCP-47 codes", () => {
    for (const code of ["en", "en-US", "fr", "de", "ja", "ko", "zh-Hant"]) {
      const out = languageToPrompt(code);
      assert.ok(out.length > 0, `expected non-empty output for "${code}"`);
      assert.match(out, new RegExp(code));
    }
  });
});
