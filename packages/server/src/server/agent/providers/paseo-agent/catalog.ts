import type { KnownProvider } from "@earendil-works/pi-ai";

export interface PaseoAgentKeyAuthHint {
  kind: "api_key";
  envVar: string;
  keyUrl?: string;
  placeholder?: string;
  hint?: string;
}

export interface PaseoAgentOAuthAuthHint {
  kind: "oauth";
  flow?: string;
}

export type PaseoAgentCatalogAuthHint = PaseoAgentKeyAuthHint | PaseoAgentOAuthAuthHint;

export interface PaseoAgentCatalogRef {
  id: string;
  piProvider: KnownProvider;
  label: string;
  iconName?: string;
  docsUrl?: string;
  auth?: PaseoAgentCatalogAuthHint;
  defaultModels?: boolean;
}

export const PASEO_AGENT_PROVIDER_CATALOG = [
  {
    id: "openrouter",
    piProvider: "openrouter",
    label: "OpenRouter",
    iconName: "openrouter",
    auth: { kind: "api_key", envVar: "OPENROUTER_API_KEY" },
    defaultModels: false,
  },
  {
    id: "chatgpt",
    piProvider: "openai-codex",
    label: "ChatGPT",
    iconName: "openai",
  },
  {
    id: "kimi",
    piProvider: "kimi-coding",
    label: "Kimi Coding Plan",
    iconName: "kimi",
    auth: { kind: "api_key", envVar: "KIMI_API_KEY" },
  },
  {
    id: "opencode-go",
    piProvider: "opencode-go",
    label: "OpenCode Go",
    iconName: "opencode",
    auth: { kind: "api_key", envVar: "OPENCODE_API_KEY" },
  },
] as const satisfies readonly PaseoAgentCatalogRef[];

const PASEO_AGENT_PROVIDER_ALIASES: Record<string, string> = {
  "openai-codex": "chatgpt",
};

export function resolvePaseoAgentCatalogEntry(
  providerType: string,
): PaseoAgentCatalogRef | undefined {
  const canonicalId = PASEO_AGENT_PROVIDER_ALIASES[providerType] ?? providerType;
  return PASEO_AGENT_PROVIDER_CATALOG.find((entry) => entry.id === canonicalId);
}

export function knownPaseoAgentCatalogIds(): string[] {
  return PASEO_AGENT_PROVIDER_CATALOG.map((entry) => entry.id);
}

export function unknownPaseoAgentProviderTypeMessage(providerType: string): string {
  return `Unknown model provider type "${providerType}". Known provider ids: ${knownPaseoAgentCatalogIds().join(", ")}. Update the host if this provider is newer than it.`;
}

export function requirePaseoAgentCatalogEntry(providerType: string): PaseoAgentCatalogRef {
  const entry = resolvePaseoAgentCatalogEntry(providerType);
  if (!entry) {
    throw new Error(unknownPaseoAgentProviderTypeMessage(providerType));
  }
  return entry;
}
