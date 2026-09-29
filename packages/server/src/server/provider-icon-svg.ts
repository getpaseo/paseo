export const MAX_PROVIDER_ICON_BYTES = 64 * 1024;

/**
 * Returns the reason an SVG cannot be used as a provider icon, or null when it
 * passes every rule. Callers wrap the reason with the source path.
 */
export function providerIconSvgFailure(svg: string): string | null {
  if (!/^\s*<svg(?:\s|>)/i.test(svg)) return "file is not an SVG document";
  if (/<script(?:\s|>)/i.test(svg)) return "script elements are not allowed";
  if (/<foreignObject(?:\s|>)/i.test(svg)) return "foreignObject elements are not allowed";
  if (/<style(?:\s|>)/i.test(svg)) return "style elements are not allowed";
  if (/\son[a-z0-9_-]*\s*=/i.test(svg)) return "event-handler attributes are not allowed";
  if (/javascript\s*:/i.test(svg)) return "javascript URLs are not allowed";

  const hrefPattern = /\s(?:href|xlink:href)\s*=\s*(?:(["'])(.*?)\1|([^\s>]+))/gi;
  for (const match of svg.matchAll(hrefPattern)) {
    const href = match[2] ?? match[3] ?? "";
    if (!href.startsWith("#")) return "external href references are not allowed";
  }
  return null;
}
