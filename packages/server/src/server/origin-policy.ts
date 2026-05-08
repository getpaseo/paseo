function parseOriginUrl(origin: string): URL | null {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function parseHostHeader(hostHeader: string): URL | null {
  try {
    return new URL(`http://${hostHeader}`);
  } catch {
    return null;
  }
}

export function isSameHostOrigin(
  origin: string | undefined,
  requestHost: string | null | undefined,
): boolean {
  if (!origin || !requestHost) {
    return false;
  }

  const originUrl = parseOriginUrl(origin);
  const requestUrl = parseHostHeader(requestHost);
  if (!originUrl || !requestUrl) {
    return false;
  }

  return originUrl.hostname.toLowerCase() === requestUrl.hostname.toLowerCase();
}

export function isOriginAllowed(input: {
  origin: string | undefined;
  requestHost: string | null | undefined;
  allowedOrigins: ReadonlySet<string>;
}): boolean {
  const { origin, requestHost, allowedOrigins } = input;
  if (!origin) {
    return true;
  }

  if (allowedOrigins.has("*") || allowedOrigins.has(origin)) {
    return true;
  }

  return isSameHostOrigin(origin, requestHost);
}
