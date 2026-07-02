import type {
  PaseoAgentCatalogEntry,
  RedactedPaseoAgentProviderConfig,
} from "@getpaseo/protocol/messages";
import type { PaseoAgentSetProviderInput } from "@/hooks/use-paseo-agent-providers";

export interface PaseoAgentApiKeyAuthManifest {
  kind: "api_key";
  envVar: string;
  keyUrl?: string;
  placeholder?: string;
  hint?: string;
}

export interface PaseoAgentOAuthAuthManifest {
  kind: "oauth";
  flow: string;
}

export interface PaseoAgentAuthBadge {
  label: string;
  variant: "success" | "error" | "muted";
}

export type PaseoAgentOAuthMode = "browser" | "device_code";

export interface PaseoAgentOAuthConnectionSignal {
  type: string;
}

export function preferredPaseoAgentOAuthMode(
  activeConnection: PaseoAgentOAuthConnectionSignal | null,
): PaseoAgentOAuthMode {
  return activeConnection?.type === "relay" ? "device_code" : "browser";
}

export function getPaseoAgentApiKeyAuth(
  entry: PaseoAgentCatalogEntry,
): PaseoAgentApiKeyAuthManifest | null {
  if (entry.auth.kind !== "api_key" || typeof entry.auth.envVar !== "string") {
    return null;
  }
  return {
    kind: "api_key",
    envVar: entry.auth.envVar,
    ...(typeof entry.auth.keyUrl === "string" ? { keyUrl: entry.auth.keyUrl } : {}),
    ...(typeof entry.auth.placeholder === "string" ? { placeholder: entry.auth.placeholder } : {}),
    ...(typeof entry.auth.hint === "string" ? { hint: entry.auth.hint } : {}),
  };
}

export function getPaseoAgentOAuthAuth(
  entry: PaseoAgentCatalogEntry,
): PaseoAgentOAuthAuthManifest | null {
  if (entry.auth.kind !== "oauth" || typeof entry.auth.flow !== "string") {
    return null;
  }
  return { kind: "oauth", flow: entry.auth.flow };
}

export function isPaseoAgentCatalogEntrySupported(entry: PaseoAgentCatalogEntry): boolean {
  return getPaseoAgentApiKeyAuth(entry) !== null || getPaseoAgentOAuthAuth(entry) !== null;
}

export function paseoAgentProviderLabel(
  provider: RedactedPaseoAgentProviderConfig,
  catalogEntry: PaseoAgentCatalogEntry | undefined,
): string {
  return catalogEntry?.label ?? provider.providerType;
}

export function paseoAgentAuthBadge(
  auth: RedactedPaseoAgentProviderConfig["auth"],
): PaseoAgentAuthBadge | null {
  if (!auth || auth.kind === "none") {
    return null;
  }
  return auth.configured
    ? { label: "Connected", variant: "success" }
    : { label: "Needs attention", variant: "error" };
}

export function parsePaseoAgentModelIds(raw: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const part of raw.split(/[\n,]/)) {
    const id = part.trim();
    if (id.length > 0 && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

export function nextPaseoAgentProviderName(
  entry: PaseoAgentCatalogEntry,
  providers: RedactedPaseoAgentProviderConfig[],
): string {
  const baseName = entry.label.trim() || entry.id;
  const existingNames = new Set(providers.map((provider) => provider.name));
  if (!existingNames.has(baseName)) {
    return baseName;
  }

  for (let index = 1; ; index += 1) {
    const candidate = `${baseName} (${index})`;
    if (!existingNames.has(candidate)) {
      return candidate;
    }
  }
}

export function createPaseoAgentProviderInput(input: {
  entry: PaseoAgentCatalogEntry;
  name: string;
  apiKey?: string;
  modelIds?: string[];
}): PaseoAgentSetProviderInput {
  const apiKeyAuth = getPaseoAgentApiKeyAuth(input.entry);
  const trimmedKey = input.apiKey?.trim() ?? "";
  let apiKey: string | undefined;
  if (apiKeyAuth) {
    apiKey = trimmedKey.length > 0 ? trimmedKey : `$${apiKeyAuth.envVar}`;
  }
  const models =
    input.modelIds && input.modelIds.length > 0
      ? input.modelIds.map((id) => ({ id }))
      : input.entry.models.map((model) => ({ ...model }));

  return {
    name: input.name.trim(),
    providerType: input.entry.id,
    options: {
      ...(models.length > 0 ? { models } : {}),
      ...(apiKey ? { apiKey } : {}),
    },
  };
}
