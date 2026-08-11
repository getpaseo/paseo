import type { ManagedMcpServerPatch, ManagedMcpServerView } from "@getpaseo/protocol/messages";
import { i18n } from "@/i18n/i18next";

export type ManagedMcpTransport = "http" | "sse" | "stdio";
export type ManagedMcpSecretSource = "value" | "env";

export interface ManagedMcpSecretRow {
  id: string;
  key: string;
  source: ManagedMcpSecretSource;
  value: string;
  preserveExisting: boolean;
}

export interface ManagedMcpServerFormState {
  name: string;
  transport: ManagedMcpTransport;
  target: string;
  args: string;
  enabled: boolean;
  alwaysLoad: boolean;
  secrets: ManagedMcpSecretRow[];
}

let nextSecretRowId = 1;

export function createManagedMcpSecretRow(): ManagedMcpSecretRow {
  return {
    id: `mcp-secret-${nextSecretRowId++}`,
    key: "",
    source: "value",
    value: "",
    preserveExisting: false,
  };
}

export function createManagedMcpServerFormState(
  name = "",
  server?: ManagedMcpServerView,
): ManagedMcpServerFormState {
  if (!server) {
    return {
      name,
      transport: "http",
      target: "",
      args: "",
      enabled: true,
      alwaysLoad: false,
      secrets: [],
    };
  }

  const secretValues = server.type === "stdio" ? server.env : server.headers;
  return {
    name,
    transport: server.type,
    target: server.type === "stdio" ? server.command : server.url,
    args: server.type === "stdio" ? (server.args ?? []).join("\n") : "",
    enabled: server.enabled !== false,
    alwaysLoad: server.alwaysLoad === true,
    secrets: Object.entries(secretValues ?? {}).map(([key, value]) => ({
      id: `mcp-secret-${nextSecretRowId++}`,
      key,
      source: value.source,
      value: value.source === "env" ? value.name : "",
      preserveExisting: value.source === "value",
    })),
  };
}

function buildSecrets(state: ManagedMcpServerFormState) {
  const entries = state.secrets.map((row) => {
    const key = row.key.trim();
    if (!key) throw new Error(i18n.t("settings.host.orchestration.managedMcp.entryNameRequired"));
    const value = row.value.trim();
    if (row.source === "env") {
      if (!value) throw new Error(i18n.t("settings.host.orchestration.managedMcp.envNameRequired"));
      return [key, { source: "env" as const, name: value }] as const;
    }
    if (row.preserveExisting && !value) {
      return [key, { source: "existing" as const }] as const;
    }
    if (!value)
      throw new Error(i18n.t("settings.host.orchestration.managedMcp.directValueRequired"));
    return [key, { source: "value" as const, value }] as const;
  });
  if (new Set(entries.map(([key]) => key)).size !== entries.length) {
    throw new Error(i18n.t("settings.host.orchestration.managedMcp.uniqueEntries"));
  }
  return Object.fromEntries(entries);
}

export function buildManagedMcpServerPatch(state: ManagedMcpServerFormState): {
  name: string;
  server: ManagedMcpServerPatch;
} {
  const name = state.name.trim();
  const target = state.target.trim();
  if (!name) throw new Error(i18n.t("settings.host.orchestration.managedMcp.nameRequired"));
  if (!target) {
    throw new Error(
      i18n.t(
        state.transport === "stdio"
          ? "settings.host.orchestration.managedMcp.commandRequired"
          : "settings.host.orchestration.managedMcp.urlRequired",
      ),
    );
  }

  const secrets = buildSecrets(state);
  if (state.transport === "stdio") {
    return {
      name,
      server: {
        type: "stdio",
        command: target,
        args: state.args
          .split("\n")
          .map((value) => value.trim())
          .filter(Boolean),
        env: secrets,
        enabled: state.enabled,
        alwaysLoad: state.alwaysLoad,
      },
    };
  }

  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new Error(i18n.t("settings.host.orchestration.managedMcp.invalidUrl"));
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(i18n.t("settings.host.orchestration.managedMcp.httpOnly"));
  }
  if (url.username || url.password) {
    throw new Error(i18n.t("settings.host.orchestration.managedMcp.invalidUrl"));
  }

  return {
    name,
    server: {
      type: state.transport,
      url: url.toString(),
      headers: secrets,
      enabled: state.enabled,
      alwaysLoad: state.alwaysLoad,
    },
  };
}

export function managedMcpViewToPatch(server: ManagedMcpServerView): ManagedMcpServerPatch {
  return buildManagedMcpServerPatch(createManagedMcpServerFormState("server", server)).server;
}
