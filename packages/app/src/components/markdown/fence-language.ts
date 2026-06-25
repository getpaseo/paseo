const MERMAID_LANGUAGE_ALIASES = new Set(["mermaid", "mmd"]);

export function normalizeFenceLanguage(info: string | null | undefined): string | null {
  if (!info) return null;
  const first = info.trim().split(/\s+/)[0]?.toLowerCase();
  if (!first) return null;
  return first.replace(/^\./, "");
}

export function isMermaidFenceLanguage(info: string | null | undefined): boolean {
  const normalized = normalizeFenceLanguage(info);
  return normalized !== null && MERMAID_LANGUAGE_ALIASES.has(normalized);
}
