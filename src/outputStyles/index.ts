/**
 * Output styles — pluggable system-prompt prefaces that swap the agent's
 * personality without touching the underlying instructions. Mirrors Claude
 * Code's `outputStyle` setting. Built-ins: default, explanatory, learning.
 *
 * Custom styles are markdown files with YAML frontmatter under:
 *   - .oh/output-styles/<name>.md  (project-level; shadows user)
 *   - ~/.oh/output-styles/<name>.md (user-level; shadows built-ins)
 *
 * A style's `prompt` is prepended to the system prompt by buildSystemPrompt.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export type OutputStyle = {
  name: string;
  description: string;
  prompt: string;
};

export const DEFAULT_STYLE: OutputStyle = {
  name: "default",
  description: "Standard software engineering assistant",
  prompt: "",
};

export const EXPLANATORY_STYLE: OutputStyle = {
  name: "explanatory",
  description: "Educational mode — adds an 'Insights' section between tasks",
  prompt:
    "You are in Explanatory mode. After completing each task, add a short '## Insights' section explaining *why* you made the choices you did — trade-offs you considered, alternatives you rejected, and one concept the user may want to learn more about. Keep insights concise (2–3 sentences).",
};

export const LEARNING_STYLE: OutputStyle = {
  name: "learning",
  description: "Collaborative learn-by-doing — leaves TODO(human) markers",
  prompt:
    "You are in Learning mode. When implementing features, leave small `TODO(human)` comments at 1–3 strategic points per task — places where the user will learn the most by writing the code themselves. Explain what each TODO should do in the surrounding comment. Never leave more than 3 TODOs per task.",
};

export const BUILTIN_STYLES: OutputStyle[] = [DEFAULT_STYLE, EXPLANATORY_STYLE, LEARNING_STYLE];

export function resolveStyleName(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed) return "default";
  return trimmed.toLowerCase();
}

type LoaderOptions = {
  /** Where to look for `.oh/output-styles/`. Defaults to `process.cwd()`. */
  projectRoot?: string;
  /** Where to look for `~/.oh/output-styles/`. Defaults to `os.homedir()`. */
  userHome?: string;
};

export function loadOutputStyle(name: string | undefined, opts: LoaderOptions = {}): OutputStyle {
  const resolved = resolveStyleName(name);
  const projectRoot = opts.projectRoot ?? process.cwd();
  const userHome = opts.userHome ?? homedir();

  // Precedence: project → user → built-in → default fallback
  const projectStyle = tryLoadFromDir(join(projectRoot, ".oh", "output-styles"), resolved);
  if (projectStyle) return projectStyle;

  const userStyle = tryLoadFromDir(join(userHome, ".oh", "output-styles"), resolved);
  if (userStyle) return userStyle;

  const builtin = BUILTIN_STYLES.find((s) => s.name === resolved);
  if (builtin) return builtin;

  return DEFAULT_STYLE;
}

function tryLoadFromDir(dir: string, name: string): OutputStyle | null {
  const path = join(dir, `${name}.md`);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    return parseStyleFile(raw, name);
  } catch {
    return null;
  }
}

function parseStyleFile(content: string, fallbackName: string): OutputStyle {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    // No frontmatter — treat the entire content as the prompt body.
    return { name: fallbackName, description: "", prompt: content.trim() };
  }
  const frontmatter = match[1]!;
  const body = match[2] ?? "";

  let parsed: Record<string, unknown> = {};
  try {
    const result = parseYaml(frontmatter);
    if (result && typeof result === "object") parsed = result as Record<string, unknown>;
  } catch {
    /* malformed frontmatter — fall back to raw body with defaults */
  }

  return {
    name: typeof parsed.name === "string" ? parsed.name : fallbackName,
    description: typeof parsed.description === "string" ? parsed.description : "",
    prompt: body.trim(),
  };
}
