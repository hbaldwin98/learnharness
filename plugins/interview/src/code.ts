/** Code questions: the editor's file name for a language, and how the learner's
 * code rides along with what they say. Pure and browser-safe. */

const EXTENSIONS: Record<string, string> = {
  javascript: "js", js: "js",
  typescript: "ts", ts: "ts",
  python: "py", py: "py",
  java: "java",
  c: "c", "c++": "cpp", cpp: "cpp",
  go: "go", rust: "rs", rs: "rs",
  "c#": "cs", csharp: "cs",
  ruby: "rb", kotlin: "kt", swift: "swift",
};

/** The editor's file label for a question. */
export function interviewCodePath(language: string): string {
  return `solution.${EXTENSIONS[language.trim().toLowerCase()] ?? "txt"}`;
}

/** The turn text: what they said, plus their code when it changed since the
 * interviewer last saw it. Either part may be absent; "" = nothing. */
export function codeTurnText(said: string, code: { language: string; content: string } | null): string {
  const parts: string[] = [];
  if (said.trim()) parts.push(said.trim());
  if (code) parts.push(`My code so far:\n\`\`\`${code.language}\n${code.content.replace(/\s+$/, "")}\n\`\`\``);
  return parts.join("\n\n");
}
