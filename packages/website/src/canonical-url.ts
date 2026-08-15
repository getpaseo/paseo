const CANONICAL_HOST = "paseo.sh";

export function getCanonicalRedirect(
  url: URL,
  environment: "development" | "production",
): string | null {
  if (environment === "development") return null;

  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (isLocal || (url.hostname === CANONICAL_HOST && url.protocol === "https:")) {
    return null;
  }

  url.protocol = "https:";
  url.hostname = CANONICAL_HOST;
  return url.toString();
}
