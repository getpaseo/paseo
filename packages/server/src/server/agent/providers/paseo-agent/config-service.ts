import type { Logger } from "pino";
import type {
  PaseoAgentOAuthCredential,
  PaseoAgentProviderAuthState,
  RedactedPaseoAgentProviderConfig,
} from "@getpaseo/protocol/messages";

import {
  loadPersistedConfig,
  savePersistedConfig,
  type PersistedConfig,
} from "../../../persisted-config.js";
import {
  isPaseoAgentDefaultModelSelection,
  PaseoAgentConfigSchema,
  paseoAgentCatalogManifests,
  type PaseoAgentConfig,
  type PaseoAgentCatalogManifestEntry,
  type PaseoAgentProviderModelConfig,
  resolvePaseoAgentCatalogAuth,
  resolvePaseoAgentProviderModels,
  resolvePaseoAgentProviderSettings,
} from "./config.js";
import { requirePaseoAgentCatalogEntry, type PaseoAgentCatalogRef } from "./catalog.js";
import {
  getStoredOAuthCredentialState,
  storeOAuthCredential,
  type OAuthCredentialBinding,
} from "./oauth-store.js";
import { isRefreshTokenExpressionConfigured } from "./oauth-credentials.js";
import { findEnvReferences } from "./env-references.js";

interface PaseoAgentConfigServiceOptions {
  paseoHome: string;
  logger: Logger;
  env?: NodeJS.ProcessEnv;
  onConfigChanged?: (config: PaseoAgentConfig | undefined) => void;
}

interface SetProviderInput {
  name: string;
  providerType: string;
  displayName?: string;
  options: {
    apiKey?: string;
    baseUrl?: string;
    api?: string;
    headers?: Record<string, string>;
    authHeader?: boolean;
    models?: PaseoAgentProviderModelConfig[];
  };
}

function resolveEnv(paseoHome: string, env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return env ?? { ...process.env, PASEO_HOME: paseoHome };
}

function authStateForApiKey(
  value: string | undefined,
  fallbackEnvVar: string | undefined,
  env: NodeJS.ProcessEnv,
): PaseoAgentProviderAuthState {
  if (!value && fallbackEnvVar) {
    return {
      kind: "api_key",
      configured: Boolean(env[fallbackEnvVar]),
      source: "default_env",
      hint: fallbackEnvVar,
    };
  }
  if (!value) {
    return { kind: "none", configured: false };
  }
  if (value.startsWith("!")) {
    return { kind: "api_key", configured: true, source: "command" };
  }
  const referencedVars = findEnvReferences(value);
  if (referencedVars.length > 0) {
    return {
      kind: "api_key",
      configured: referencedVars.every((name) => Boolean(env[name])),
      source: "env",
      hint: referencedVars.join(","),
    };
  }
  return { kind: "api_key", configured: true, source: "literal" };
}

function copyCatalogEntry(entry: PaseoAgentCatalogManifestEntry): PaseoAgentCatalogManifestEntry {
  return {
    ...entry,
    ...(entry.headers ? { headers: { ...entry.headers } } : {}),
    auth: { ...entry.auth },
    models: entry.models.map((model) => ({ ...model })),
  };
}

function providerOptionsForPersist(
  options: SetProviderInput["options"],
  catalogEntry: PaseoAgentCatalogRef,
): SetProviderInput["options"] {
  if (!isPaseoAgentDefaultModelSelection(options.models, catalogEntry)) {
    return options;
  }
  const rest = { ...options };
  delete rest.models;
  return rest;
}

function oauthBindingForSettings(
  flow: string,
  settings: ReturnType<typeof resolvePaseoAgentProviderSettings>,
): OAuthCredentialBinding {
  return { flow, baseUrl: settings.baseUrl };
}

function readPaseoAgentConfig(persisted: PersistedConfig): PaseoAgentConfig {
  return validatePaseoAgentConfig(PaseoAgentConfigSchema.parse(persisted.agents?.paseo ?? {}));
}

function validatePaseoAgentConfig(config: PaseoAgentConfig): PaseoAgentConfig {
  for (const entry of Object.values(config.providers ?? {})) {
    requirePaseoAgentCatalogEntry(entry.type);
  }
  return config;
}

function redactedProviders(
  config: PaseoAgentConfig,
  env: NodeJS.ProcessEnv,
): RedactedPaseoAgentProviderConfig[] {
  return Object.entries(config.providers ?? {}).map(([name, entry]) => {
    const catalogEntry = requirePaseoAgentCatalogEntry(entry.type);
    const authManifest = resolvePaseoAgentCatalogAuth(catalogEntry);
    const settings = resolvePaseoAgentProviderSettings(entry, catalogEntry);
    const models = resolvePaseoAgentProviderModels(entry, catalogEntry);
    let auth: PaseoAgentProviderAuthState;
    if (authManifest.kind === "oauth") {
      const hasRefreshToken =
        entry.options.refreshToken &&
        isRefreshTokenExpressionConfigured(entry.options.refreshToken, env);
      if (hasRefreshToken) {
        auth = { kind: "oauth", configured: true, source: "refresh_token" };
      } else {
        const stored = getStoredOAuthCredentialState(
          name,
          env,
          oauthBindingForSettings(authManifest.flow, settings),
        );
        if (stored.present && stored.bindingMatches) {
          auth = { kind: "oauth", configured: true, source: "stored" };
        } else if (stored.present) {
          auth = {
            kind: "oauth",
            configured: false,
            source: "stored",
            hint: "binding_mismatch",
          };
        } else {
          auth = { kind: "oauth", configured: false };
        }
      }
    } else {
      auth = authStateForApiKey(entry.options.apiKey, authManifest.envVar, env);
    }
    const provider: RedactedPaseoAgentProviderConfig = {
      name,
      providerType: catalogEntry.id,
      models: models.map((model) => Object.assign({}, model)),
      auth,
      available: auth.configured,
      error: null,
    };
    if (entry.displayName) {
      provider.displayName = entry.displayName;
    }
    provider.baseUrl = settings.baseUrl;
    provider.api = settings.api;
    return provider;
  });
}

function mergePaseoAgentConfig(
  persisted: PersistedConfig,
  paseoConfig: PaseoAgentConfig | undefined,
): PersistedConfig {
  return {
    ...persisted,
    agents: {
      ...persisted.agents,
      paseo: paseoConfig,
    },
  };
}

export class PaseoAgentConfigService {
  private readonly paseoHome: string;
  private readonly logger: Logger;
  private readonly env: NodeJS.ProcessEnv;
  private readonly onConfigChanged: ((config: PaseoAgentConfig | undefined) => void) | undefined;

  constructor(options: PaseoAgentConfigServiceOptions) {
    this.paseoHome = options.paseoHome;
    this.logger = options.logger.child({ module: "paseo-agent-config-service" });
    this.env = resolveEnv(options.paseoHome, options.env);
    this.onConfigChanged = options.onConfigChanged;
  }

  getCatalog(): PaseoAgentCatalogManifestEntry[] {
    return paseoAgentCatalogManifests().map(copyCatalogEntry);
  }

  getProviders(): { defaultModel: string | null; providers: RedactedPaseoAgentProviderConfig[] } {
    const config = readPaseoAgentConfig(loadPersistedConfig(this.paseoHome, this.logger));
    return {
      defaultModel: config.defaultModel ?? null,
      providers: redactedProviders(config, this.env),
    };
  }

  setProvider(input: SetProviderInput): RedactedPaseoAgentProviderConfig {
    const catalogEntry = requirePaseoAgentCatalogEntry(input.providerType);
    const next = this.updateConfig((current) =>
      PaseoAgentConfigSchema.parse({
        ...current,
        providers: {
          ...current.providers,
          [input.name]: {
            type: catalogEntry.id,
            ...((input.displayName ?? current.providers?.[input.name]?.displayName)
              ? { displayName: input.displayName ?? current.providers?.[input.name]?.displayName }
              : {}),
            options: providerOptionsForPersist(input.options, catalogEntry),
          },
        },
      }),
    );
    return this.requireRedactedProvider(next, input.name);
  }

  renameProvider(name: string, displayName: string): RedactedPaseoAgentProviderConfig {
    const trimmedDisplayName = displayName.trim();
    const next = this.updateConfig((current) => {
      const provider = current.providers?.[name];
      if (!provider) {
        throw new Error(`Paseo Agent provider '${name}' is not configured.`);
      }
      return PaseoAgentConfigSchema.parse({
        ...current,
        providers: {
          ...current.providers,
          [name]: {
            ...provider,
            displayName: trimmedDisplayName,
          },
        },
      });
    });
    return this.requireRedactedProvider(next, name);
  }

  removeProvider(name: string): boolean {
    let removed = false;
    this.updateConfig((current) => {
      const providers = { ...current.providers };
      removed = Object.prototype.hasOwnProperty.call(providers, name);
      delete providers[name];
      return PaseoAgentConfigSchema.parse({
        ...current,
        ...(Object.keys(providers).length > 0 ? { providers } : { providers: undefined }),
        ...(current.defaultModel?.startsWith(`${name}/`) ? { defaultModel: undefined } : {}),
      });
    });
    return removed;
  }

  getOAuthCredentialBinding(providerName: string): OAuthCredentialBinding {
    const config = readPaseoAgentConfig(loadPersistedConfig(this.paseoHome, this.logger));
    const entry = config.providers?.[providerName];
    if (!entry) {
      throw new Error(`Paseo Agent provider '${providerName}' is not configured.`);
    }
    const catalogEntry = requirePaseoAgentCatalogEntry(entry.type);
    const authManifest = resolvePaseoAgentCatalogAuth(catalogEntry);
    if (authManifest.kind !== "oauth") {
      throw new Error(`Paseo Agent provider '${providerName}' does not use OAuth.`);
    }
    const settings = resolvePaseoAgentProviderSettings(entry, catalogEntry);
    return oauthBindingForSettings(authManifest.flow, settings);
  }

  storeOAuthCredential(
    providerName: string,
    credential: PaseoAgentOAuthCredential,
    binding: OAuthCredentialBinding | undefined = undefined,
  ): PaseoAgentProviderAuthState {
    const config = readPaseoAgentConfig(loadPersistedConfig(this.paseoHome, this.logger));
    const entry = config.providers?.[providerName];
    if (!entry) {
      throw new Error(`Paseo Agent provider '${providerName}' is not configured.`);
    }
    const catalogEntry = requirePaseoAgentCatalogEntry(entry.type);
    const authManifest = resolvePaseoAgentCatalogAuth(catalogEntry);
    if (authManifest.kind !== "oauth") {
      throw new Error(`Paseo Agent provider '${providerName}' does not use OAuth.`);
    }
    const settings = resolvePaseoAgentProviderSettings(entry, catalogEntry);
    storeOAuthCredential({
      providerInstance: providerName,
      credential,
      binding: binding ?? oauthBindingForSettings(authManifest.flow, settings),
      env: this.env,
    });
    this.onConfigChanged?.(config);
    return (
      this.requireRedactedProvider(config, providerName).auth ?? {
        kind: "oauth",
        configured: false,
      }
    );
  }

  private requireRedactedProvider(
    config: PaseoAgentConfig,
    name: string,
  ): RedactedPaseoAgentProviderConfig {
    const provider = redactedProviders(config, this.env).find((entry) => entry.name === name);
    if (!provider) {
      throw new Error(`Paseo Agent provider '${name}' was not found after update.`);
    }
    return provider;
  }

  private updateConfig(update: (current: PaseoAgentConfig) => PaseoAgentConfig): PaseoAgentConfig {
    const persisted = loadPersistedConfig(this.paseoHome, this.logger);
    const next = validatePaseoAgentConfig(update(readPaseoAgentConfig(persisted)));
    savePersistedConfig(this.paseoHome, mergePaseoAgentConfig(persisted, next), this.logger);
    this.onConfigChanged?.(next);
    return next;
  }
}
