import { rewriteLoopbackUrl } from "@/utils/host-loopback-url";

/** Paperclip issue prefixes of this host's board and the address its web app answers on. */
export interface PaperclipLinkConfig {
  webBaseUrl: string;
  prefixes: readonly string[];
}

export type PaperclipTextSegment = { kind: "text"; text: string } | { kind: "issue"; key: string };

function keyPattern(prefixes: readonly string[]): RegExp | null {
  const safe = prefixes.filter((prefix) => /^[A-Z][A-Z0-9]*$/.test(prefix));
  if (safe.length === 0) return null;
  // Longest prefix first so VIZA-4 is never read as VIZ followed by "A-4".
  const alternatives = [...safe].sort((a, b) => b.length - a.length).join("|");
  return new RegExp(`(?<![A-Za-z0-9_/-])(?:${alternatives})-\\d+(?![A-Za-z0-9_-])`, "g");
}

/** The daemon reads Paperclip on loopback; a client elsewhere reaches it on the host's address. */
export function resolvePaperclipWebBase(webBaseUrl: string, hostEndpoint: string | null): string {
  return rewriteLoopbackUrl(webBaseUrl, hostEndpoint).replace(/\/+$/, "");
}

export function paperclipIssueUrl(config: PaperclipLinkConfig, key: string): string {
  const prefix = key.slice(0, key.lastIndexOf("-"));
  return `${config.webBaseUrl}/${prefix}/issues/${key}`;
}

/** Splits text around Paperclip keys (VIZ-70, VIZA-4) of the board's own prefixes. */
export function splitPaperclipKeys(
  text: string,
  prefixes: readonly string[],
): PaperclipTextSegment[] {
  const pattern = keyPattern(prefixes);
  if (!pattern) return [{ kind: "text", text }];
  const segments: PaperclipTextSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) segments.push({ kind: "text", text: text.slice(last, start) });
    segments.push({ kind: "issue", key: match[0] });
    last = start + match[0].length;
  }
  if (last < text.length) segments.push({ kind: "text", text: text.slice(last) });
  return segments.length > 0 ? segments : [{ kind: "text", text }];
}

/** An inline code span that is exactly one Paperclip key, such as `VIZ-70`. */
export function paperclipKeyOfCode(code: string, prefixes: readonly string[]): string | null {
  const segments = splitPaperclipKeys(code.trim(), prefixes);
  return segments.length === 1 && segments[0]?.kind === "issue" ? segments[0].key : null;
}

/**
 * Links agents already write to Paperclip issues (/VIZ/issues/VIZ-61, http://localhost:3110/…)
 * rewritten to the address this client reaches. Null when the link is not a Paperclip issue.
 */
export function rewritePaperclipHref(href: string, config: PaperclipLinkConfig): string | null {
  const match =
    /^(?:https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?)?\/([A-Z][A-Z0-9]*)\/issues\/([A-Z][A-Z0-9]*-\d+)(?:[/?#].*)?$/.exec(
      href.trim(),
    );
  if (!match) return null;
  const [, companyPrefix, key] = match;
  if (!companyPrefix || !key || !config.prefixes.includes(companyPrefix)) return null;
  return paperclipIssueUrl(config, key);
}

export function isPaperclipIssueUrl(url: string, config: PaperclipLinkConfig): boolean {
  return url.startsWith(`${config.webBaseUrl}/`) && /\/issues\/[A-Z][A-Z0-9]*-\d+/.test(url);
}
