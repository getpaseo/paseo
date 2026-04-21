import path from "node:path";
import { z } from "zod";

import type { PaseoDaemonConfig } from "./bootstrap.js";
import { loadPersistedConfig } from "./persisted-config.js";
import type { AgentProvider } from "./agent/agent-sdk-types.js";
import type {
  AgentProviderRuntimeSettingsMap,
  ProviderOverride,
} from "./agent/provider-launch-config.js";
import { ProviderOverrideSchema } from "./agent/provider-launch-config.js";
import { AgentProviderSchema } from "./agent/provider-manifest.js";
import { resolveSpeechConfig } from "./speech/speech-config-resolver.js";
import { mergeHostnames, parseHostnamesEnv, type HostnamesConfig } from "./hostnames.js";
import type { PaseoWeChatConfig } from "./wechat/types.js";

const DEFAULT_PORT = 6767;
const DEFAULT_RELAY_ENDPOINT = "relay.paseo.sh:443";
const DEFAULT_APP_BASE_URL = "https://app.paseo.sh";

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return undefined;
}

export type CliConfigOverrides = Partial<{
  listen: string;
  relayEnabled: boolean;
  mcpEnabled: boolean;
  mcpInjectIntoAgents: boolean;
  hostnames: HostnamesConfig;
}>;

const OptionalVoiceLlmProviderSchema = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((value): string | null =>
    typeof value === "string" ? value.trim().toLowerCase() : null,
  )
  .pipe(z.union([AgentProviderSchema, z.null()]));

function parseOptionalVoiceLlmProvider(value: unknown): AgentProvider | null {
  const parsed = OptionalVoiceLlmProviderSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function extractProviderOverrides(
  providers: Record<string, unknown> | undefined,
): Record<string, ProviderOverride> | undefined {
  if (!providers) {
    return undefined;
  }

  const providerOverrides = Object.entries(providers).flatMap(([providerId, provider]) => {
    const parsed = ProviderOverrideSchema.safeParse(provider);
    return parsed.success ? [[providerId, parsed.data] as const] : [];
  });

  return providerOverrides.length > 0 ? Object.fromEntries(providerOverrides) : undefined;
}

function extractAgentProviderSettings(
  providerOverrides: Record<string, ProviderOverride> | undefined,
): AgentProviderRuntimeSettingsMap | undefined {
  if (!providerOverrides) {
    return undefined;
  }

  const runtimeSettings = Object.entries(providerOverrides).flatMap(([providerId, provider]) => {
    const parsedProviderId = AgentProviderSchema.safeParse(providerId);
    if (!parsedProviderId.success || (!provider.command && !provider.env)) {
      return [];
    }

    return [
      [
        parsedProviderId.data,
        {
          command: provider.command
            ? {
                mode: "replace" as const,
                argv: provider.command,
              }
            : undefined,
          env: provider.env,
        },
      ] as const,
    ];
  });

  return runtimeSettings.length > 0
    ? (Object.fromEntries(runtimeSettings) as AgentProviderRuntimeSettingsMap)
    : undefined;
}

function resolveWeChatConfig(
  value: Record<string, unknown> | undefined,
  cwdFallback: string,
): PaseoWeChatConfig {
  const enabled = value?.enabled === true;
  const autoStart = value?.autoStart !== false;
  const provider =
    typeof value?.provider === "string" && value.provider.trim().length > 0
      ? value.provider.trim()
      : "codex";
  const cwd =
    typeof value?.cwd === "string" && value.cwd.trim().length > 0
      ? value.cwd.trim()
      : cwdFallback;

  return {
    enabled,
    autoStart,
    provider,
    cwd,
    modeId: typeof value?.modeId === "string" ? value.modeId.trim() || undefined : undefined,
    model:
      typeof value?.model === "string" && value.model.trim().length > 0
        ? value.model.trim()
        : null,
    systemPrompt:
      typeof value?.systemPrompt === "string" && value.systemPrompt.trim().length > 0
        ? value.systemPrompt
        : undefined,
    approvalPolicy:
      typeof value?.approvalPolicy === "string" && value.approvalPolicy.trim().length > 0
        ? value.approvalPolicy.trim()
        : undefined,
    sandboxMode:
      typeof value?.sandboxMode === "string" && value.sandboxMode.trim().length > 0
        ? value.sandboxMode.trim()
        : undefined,
    networkAccess: value?.networkAccess === true,
    webSearch: value?.webSearch === true,
    qrApiBaseUrl:
      typeof value?.qrApiBaseUrl === "string" && value.qrApiBaseUrl.trim().length > 0
        ? value.qrApiBaseUrl.trim()
        : undefined,
    apiBaseUrl:
      typeof value?.apiBaseUrl === "string" && value.apiBaseUrl.trim().length > 0
        ? value.apiBaseUrl.trim()
        : undefined,
    pollTimeoutMs:
      typeof value?.pollTimeoutMs === "number" && Number.isFinite(value.pollTimeoutMs)
        ? value.pollTimeoutMs
        : undefined,
  };
}

export function loadConfig(
  paseoHome: string,
  options?: {
    env?: NodeJS.ProcessEnv;
    cli?: CliConfigOverrides;
  },
): PaseoDaemonConfig {
  const env = options?.env ?? process.env;
  const persisted = loadPersistedConfig(paseoHome);

  // PASEO_LISTEN can be:
  // - host:port (TCP)
  // - /path/to/socket (Unix socket)
  // - unix:///path/to/socket (Unix socket)
  // Default is TCP at 127.0.0.1:6767
  const listen =
    options?.cli?.listen ??
    env.PASEO_LISTEN ??
    persisted.daemon?.listen ??
    `127.0.0.1:${env.PORT ?? DEFAULT_PORT}`;

  const envCorsOrigins = env.PASEO_CORS_ORIGINS
    ? env.PASEO_CORS_ORIGINS.split(",").map((s) => s.trim())
    : [];

  const persistedCorsOrigins = persisted.daemon?.cors?.allowedOrigins ?? [];

  const hostnames = mergeHostnames([
    persisted.daemon?.hostnames,
    parseHostnamesEnv(env.PASEO_HOSTNAMES ?? env.PASEO_ALLOWED_HOSTS),
    options?.cli?.hostnames,
  ]);

  const mcpEnabled = options?.cli?.mcpEnabled ?? persisted.daemon?.mcp?.enabled ?? true;
  const mcpInjectIntoAgents =
    options?.cli?.mcpInjectIntoAgents ?? persisted.daemon?.mcp?.injectIntoAgents ?? false;

  const relayEnabled =
    options?.cli?.relayEnabled ??
    parseBooleanEnv(env.PASEO_RELAY_ENABLED) ??
    persisted.daemon?.relay?.enabled ??
    true;

  const relayEndpoint =
    env.PASEO_RELAY_ENDPOINT ?? persisted.daemon?.relay?.endpoint ?? DEFAULT_RELAY_ENDPOINT;

  const relayPublicEndpoint =
    env.PASEO_RELAY_PUBLIC_ENDPOINT ?? persisted.daemon?.relay?.publicEndpoint ?? relayEndpoint;

  const appBaseUrl = env.PASEO_APP_BASE_URL ?? persisted.app?.baseUrl ?? DEFAULT_APP_BASE_URL;

  const { openai, speech } = resolveSpeechConfig({
    paseoHome,
    env,
    persisted,
  });

  const envVoiceLlmProvider = parseOptionalVoiceLlmProvider(env.PASEO_VOICE_LLM_PROVIDER);
  const persistedVoiceLlmProvider = parseOptionalVoiceLlmProvider(
    persisted.features?.voiceMode?.llm?.provider,
  );
  const voiceLlmProvider = envVoiceLlmProvider ?? persistedVoiceLlmProvider ?? null;
  const voiceLlmProviderExplicit =
    envVoiceLlmProvider !== null || persistedVoiceLlmProvider !== null;
  const voiceLlmModel = persisted.features?.voiceMode?.llm?.model ?? null;
  const providerOverrides = extractProviderOverrides(
    persisted.agents?.providers as Record<string, unknown> | undefined,
  );
  const wechat = resolveWeChatConfig(
    persisted.channels?.wechat as Record<string, unknown> | undefined,
    process.cwd(),
  );

  return {
    listen,
    paseoHome,
    corsAllowedOrigins: Array.from(
      new Set([...persistedCorsOrigins, ...envCorsOrigins].filter((s) => s.length > 0)),
    ),
    hostnames,
    mcpEnabled,
    mcpInjectIntoAgents,
    mcpDebug: env.MCP_DEBUG === "1",
    isDev: env.NODE_ENV === "development",
    agentStoragePath: path.join(paseoHome, "agents"),
    staticDir: "public",
    agentClients: {},
    relayEnabled,
    relayEndpoint,
    relayPublicEndpoint,
    appBaseUrl,
    openai,
    speech,
    voiceLlmProvider,
    voiceLlmProviderExplicit,
    voiceLlmModel,
    agentProviderSettings: extractAgentProviderSettings(providerOverrides),
    providerOverrides,
    wechat,
  };
}
