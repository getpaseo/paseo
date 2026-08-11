import {
  ManagedMcpServerConfigSchema,
  MAX_MANAGED_MCP_SERVERS,
  type ManagedMcpServerConfig,
  type ManagedMcpServerPatch,
  type ManagedMcpServerView,
} from "@getpaseo/protocol/messages";
import type { McpServerConfig } from "./agent/agent-sdk-types.js";

type SecretValue = { source: "env"; name: string } | { source: "value"; value: string };
type SecretPatch = SecretValue | { source: "existing" };
const MAX_MANAGED_MCP_SECRET_ENTRIES = 64;

function assertRecordSize(
  serverName: string,
  fieldName: string,
  values: Record<string, unknown> | undefined,
): void {
  if (Object.keys(values ?? {}).length > MAX_MANAGED_MCP_SECRET_ENTRIES) {
    throw new Error(
      `MCP server '${serverName}' supports at most ${MAX_MANAGED_MCP_SECRET_ENTRIES} ${fieldName} entries`,
    );
  }
}

function resolveExistingSecret(
  serverName: string,
  fieldName: string,
  key: string,
  patch: SecretPatch,
  current: SecretValue | undefined,
): SecretValue {
  if (patch.source !== "existing") {
    return patch;
  }
  if (!current) {
    throw new Error(
      `MCP server '${serverName}' cannot preserve missing ${fieldName} value '${key}'`,
    );
  }
  return current;
}

function applySecretRecordPatch(
  serverName: string,
  fieldName: string,
  patch: Record<string, SecretPatch> | undefined,
  current: Record<string, SecretValue> | undefined,
): Record<string, SecretValue> | undefined {
  if (!patch) return undefined;
  return Object.fromEntries(
    Object.entries(patch).map(([key, value]) => [
      key,
      resolveExistingSecret(serverName, fieldName, key, value, current?.[key]),
    ]),
  );
}

function materializeServerPatch(
  name: string,
  patch: ManagedMcpServerPatch,
  current: ManagedMcpServerConfig | undefined,
): ManagedMcpServerConfig {
  if (patch.type === "stdio") {
    assertRecordSize(name, "environment", patch.env);
    return ManagedMcpServerConfigSchema.parse({
      ...patch,
      env: applySecretRecordPatch(
        name,
        "environment",
        patch.env,
        current?.type === "stdio" ? current.env : undefined,
      ),
    });
  }

  const currentHeaders =
    current?.type === "http" || current?.type === "sse" ? current.headers : undefined;
  assertRecordSize(name, "header", patch.headers);
  return ManagedMcpServerConfigSchema.parse({
    ...patch,
    headers: applySecretRecordPatch(name, "header", patch.headers, currentHeaders),
  });
}

export function applyManagedMcpServerPatch(params: {
  current: Record<string, ManagedMcpServerConfig> | undefined;
  upsert: Record<string, ManagedMcpServerPatch> | undefined;
  remove: readonly string[];
}): Record<string, ManagedMcpServerConfig> {
  const next = { ...params.current };
  for (const name of new Set(params.remove)) {
    delete next[name];
  }
  for (const [name, patch] of Object.entries(params.upsert ?? {})) {
    next[name] = materializeServerPatch(name, patch, next[name]);
  }
  if (Object.keys(next).length > MAX_MANAGED_MCP_SERVERS) {
    throw new Error(`A host supports at most ${MAX_MANAGED_MCP_SERVERS} managed MCP servers`);
  }
  return next;
}

function redactSecretRecord(
  values: Record<string, SecretValue> | undefined,
):
  | Record<string, { source: "env"; name: string } | { source: "value"; configured: true }>
  | undefined {
  if (!values) return undefined;
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      value.source === "env"
        ? value
        : {
            source: "value" as const,
            configured: true as const,
          },
    ]),
  );
}

export function redactManagedMcpServers(
  servers: Record<string, ManagedMcpServerConfig> | undefined,
): Record<string, ManagedMcpServerView> {
  return Object.fromEntries(
    Object.entries(servers ?? {}).map(([name, server]) => {
      if (server.type === "stdio") {
        return [name, { ...server, env: redactSecretRecord(server.env) }];
      }
      const url = new URL(server.url);
      url.username = "";
      url.password = "";
      return [
        name,
        { ...server, url: url.toString(), headers: redactSecretRecord(server.headers) },
      ];
    }),
  );
}

function resolveSecret(
  serverName: string,
  fieldName: string,
  key: string,
  value: SecretValue,
  env: NodeJS.ProcessEnv,
): string {
  if (value.source === "value") return value.value;
  const resolved = env[value.name];
  if (!resolved) {
    throw new Error(
      `MCP server '${serverName}' requires environment variable '${value.name}' for ${fieldName} '${key}'`,
    );
  }
  return resolved;
}

function resolveSecretRecord(
  serverName: string,
  fieldName: string,
  values: Record<string, SecretValue> | undefined,
  env: NodeJS.ProcessEnv,
): Record<string, string> | undefined {
  if (!values) return undefined;
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      resolveSecret(serverName, fieldName, key, value, env),
    ]),
  );
}

function requireHttpUrl(serverName: string, rawUrl: string): string {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`MCP server '${serverName}' URL must use http or https`);
  }
  if (url.username || url.password) {
    throw new Error(`MCP server '${serverName}' URL cannot include credentials`);
  }
  return url.toString();
}

export function resolveManagedMcpServer(
  name: string,
  server: ManagedMcpServerConfig,
  env: NodeJS.ProcessEnv = process.env,
): McpServerConfig {
  if (server.type === "stdio") {
    return {
      type: "stdio",
      command: server.command,
      ...(server.args ? { args: server.args } : {}),
      ...(server.env ? { env: resolveSecretRecord(name, "environment", server.env, env) } : {}),
      ...(server.alwaysLoad !== undefined ? { alwaysLoad: server.alwaysLoad } : {}),
    };
  }
  return {
    type: server.type,
    url: requireHttpUrl(name, server.url),
    ...(server.headers
      ? { headers: resolveSecretRecord(name, "header", server.headers, env) }
      : {}),
    ...(server.alwaysLoad !== undefined ? { alwaysLoad: server.alwaysLoad } : {}),
  };
}

export function resolveManagedMcpServers(
  servers: Record<string, ManagedMcpServerConfig> | undefined,
  env: NodeJS.ProcessEnv = process.env,
  excludedNames: readonly string[] = [],
): Record<string, McpServerConfig> {
  const excluded = new Set(excludedNames);
  return Object.fromEntries(
    Object.entries(servers ?? {})
      .filter(([name, server]) => server.enabled !== false && !excluded.has(name))
      .map(([name, server]) => [name, resolveManagedMcpServer(name, server, env)]),
  );
}
