export const EXTERNAL_SERVER_URL_ENV = "PASEO_OPENCODE_SERVER_URL";
export const EXTERNAL_SERVER_PASSWORD_ENV = "PASEO_OPENCODE_SERVER_PASSWORD";

export interface ExternalOpenCodeServer {
  url: string;
  password?: string;
}

/**
 * Reads the optional connection to a user-managed OpenCode v2 server from
 * provider environment. When absent, Paseo keeps spawning its own server.
 */
export function resolveExternalOpenCodeServer(
  env: Record<string, string | undefined> | undefined,
): ExternalOpenCodeServer | undefined {
  const rawUrl = env?.[EXTERNAL_SERVER_URL_ENV]?.trim();
  if (!rawUrl) return undefined;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`${EXTERNAL_SERVER_URL_ENV} must be an absolute URL, received "${rawUrl}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${EXTERNAL_SERVER_URL_ENV} must use http or https, received "${rawUrl}"`);
  }
  if (url.username || url.password)
    throw new Error(
      `${EXTERNAL_SERVER_URL_ENV} must not contain credentials; use ${EXTERNAL_SERVER_PASSWORD_ENV}`,
    );

  const password = env?.[EXTERNAL_SERVER_PASSWORD_ENV];
  return {
    url: url.toString().replace(/\/$/, ""),
    ...(password ? { password } : {}),
  };
}
