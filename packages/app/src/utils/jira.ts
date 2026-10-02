const JIRA_KEY_PATTERN = /\b[A-Z][A-Z0-9]+-\d+\b/g;

export function extractJiraKeys(texts: readonly (string | null | undefined)[]): string[] {
  const keys = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(JIRA_KEY_PATTERN)) {
      keys.add(match[0]);
    }
  }
  return [...keys];
}

export function normalizeJiraSite(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!url.hostname) return null;
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}`;
}

export function buildJiraIssueUrl(site: string, key: string): string {
  return `${site}/browse/${encodeURIComponent(key)}`;
}
