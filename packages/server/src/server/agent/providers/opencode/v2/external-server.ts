export const EXTERNAL_SERVER_URL_ENV = "PASEO_OPENCODE_SERVER_URL";
export const EXTERNAL_SERVER_PASSWORD_ENV = "PASEO_OPENCODE_SERVER_PASSWORD";
export const SERVER_SCOPE_ENV = "PASEO_OPENCODE_SERVER_SCOPE";

/**
 * How Paseo groups the OpenCode servers it starts. `shared` reuses a configured
 * or discovered server, else shares one helper. `workspace` and `agent` always
 * start Paseo's own helpers: one per workspace, or one per agent.
 */
export const OPENCODE_SERVER_SCOPES = ["shared", "workspace", "agent"] as const;
export type OpenCodeServerScope = (typeof OPENCODE_SERVER_SCOPES)[number];

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

export function resolveOpenCodeServerScope(
  env: Record<string, string | undefined> | undefined,
): OpenCodeServerScope {
  const raw = env?.[SERVER_SCOPE_ENV]?.trim();
  if (!raw) return "shared";
  const scope = OPENCODE_SERVER_SCOPES.find((candidate) => candidate === raw);
  if (!scope)
    throw new Error(
      `${SERVER_SCOPE_ENV} must be one of ${OPENCODE_SERVER_SCOPES.join(", ")}, received "${raw}"`,
    );
  return scope;
}
