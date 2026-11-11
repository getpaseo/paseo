// Applies a web base URL (Expo `experiments.baseUrl`) to the files Expo copies
// from packages/app/public without rewriting: the hand-written <link> tags in
// index.html and the root-relative paths in manifest.json.

/** Normalizes PASEO_WEB_BASE_URL to "" or "/a/b". Throws on anything else. */
export function normalizeWebBaseUrl(input) {
  const trimmed = (input ?? "").trim();
  if (!trimmed || trimmed === "/") {
    return "";
  }
  if (!trimmed.startsWith("/") || /[?#\\\s]/.test(trimmed)) {
    throw new Error(`Invalid PASEO_WEB_BASE_URL "${trimmed}": must be an absolute URL path`);
  }
  const segments = trimmed.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`Invalid PASEO_WEB_BASE_URL "${trimmed}": must not contain "." or ".."`);
  }
  return `/${segments.join("/")}`;
}

function prefixRootPath(value, baseUrl) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return value;
  }
  if (value === baseUrl || value.startsWith(`${baseUrl}/`)) {
    return value;
  }
  return value === "/" ? `${baseUrl}/` : `${baseUrl}${value}`;
}

const PUBLIC_LINK_PATTERN =
  /(<link\b[^>]*\brel="(?:manifest|apple-touch-icon)"[^>]*\bhref=")([^"]*)(")/g;

export function applyWebBaseUrlToIndexHtml(html, baseUrl) {
  if (!baseUrl) {
    return html;
  }
  return html.replace(
    PUBLIC_LINK_PATTERN,
    (_match, before, href, after) => `${before}${prefixRootPath(href, baseUrl)}${after}`,
  );
}

export function applyWebBaseUrlToManifest(manifest, baseUrl) {
  if (!baseUrl) {
    return manifest;
  }
  const next = { ...manifest };
  for (const key of ["id", "start_url", "scope"]) {
    if (key in next) {
      next[key] = prefixRootPath(next[key], baseUrl);
    }
  }
  if (Array.isArray(next.icons)) {
    next.icons = next.icons.map((icon) => ({ ...icon, src: prefixRootPath(icon.src, baseUrl) }));
  }
  return next;
}
