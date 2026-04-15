/**
 * Skills Registry — search and install community skills from a remote registry.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_REGISTRY_URL = "https://raw.githubusercontent.com/zhijiewong/openharness/main/data/registry.json";
const GLOBAL_SKILLS_DIR = join(homedir(), ".oh", "skills");

export type RegistrySkill = {
  name: string;
  description: string;
  author: string;
  version: string;
  source: string; // URL to raw .md file
  tags: string[];
};

export type Registry = {
  skills: RegistrySkill[];
};

/** Fetch the registry from remote URL */
export async function fetchRegistry(url: string = DEFAULT_REGISTRY_URL): Promise<Registry> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch registry: ${response.status}`);
  return (await response.json()) as Registry;
}

/** Search registry by query (matches name, description, tags) */
export function searchRegistry(registry: Registry, query: string): RegistrySkill[] {
  const q = query.toLowerCase();
  return registry.skills.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.tags.some((t) => t.toLowerCase().includes(q)),
  );
}

/** Install a skill from the registry to ~/.oh/skills/ */
export async function installSkill(skill: RegistrySkill): Promise<string> {
  const response = await fetch(skill.source);
  if (!response.ok) throw new Error(`Failed to download skill: ${response.status}`);
  const content = await response.text();

  mkdirSync(GLOBAL_SKILLS_DIR, { recursive: true });
  const slug = skill.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const filePath = join(GLOBAL_SKILLS_DIR, `${slug}.md`);
  writeFileSync(filePath, content);
  return filePath;
}
