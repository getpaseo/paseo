export function getMarkdownFenceLanguage(info: string | null | undefined): string | null {
  return info?.trim().split(/\s+/)[0]?.toLowerCase() || null;
}
