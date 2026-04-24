/**
 * Language directive — injected into the system prompt when the user has set
 * `language:` in .oh/config.yaml. Tells the model to respond in the configured
 * language while leaving code, commands, file paths, and identifiers in their
 * original form.
 */

export function languageToPrompt(language?: string): string {
  const lang = language?.trim();
  if (!lang) return "";
  return `Respond to the user in ${lang}. Code, shell commands, variable names, file paths, and identifiers stay in their original language.`;
}
