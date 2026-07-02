import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import type { Command } from "commander";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  PaseoAgentCatalogEntry,
  PaseoAgentOAuthCredential,
  PaseoAgentProviderAuthState,
  RedactedPaseoAgentProviderConfig,
} from "@getpaseo/protocol/messages";
import { loginOAuthBrowser } from "@getpaseo/server";

import { connectToDaemon } from "../../utils/client.js";
import { collectMultiple } from "../../utils/command-options.js";
import { openBrowserUrl } from "../../utils/open-browser.js";
import { requirePaseoAgentCatalogFeature } from "./feature.js";
import type {
  CommandError,
  CommandOptions,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";

interface ProviderAddOptions extends CommandOptions {
  name?: string;
  apiKeyStdin?: boolean;
  deviceCode?: boolean;
  model?: string[];
}

interface ProviderModelInput {
  id: string;
  label?: string;
  api?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

interface ProviderConfiguredItem {
  name: string;
  providerType: string;
  label: string;
  auth: string;
  available: string;
  models: string;
}

interface ProviderAddClient extends Pick<
  DaemonClient,
  | "waitForServerInfo"
  | "getPaseoAgentCatalog"
  | "setPaseoAgentProvider"
  | "startPaseoAgentOAuth"
  | "completePaseoAgentOAuth"
  | "storePaseoAgentOAuthCredential"
  | "close"
> {}

export interface ProviderAddDependencies {
  connectDaemon: (options: { host?: string }) => Promise<ProviderAddClient>;
  readStdin: () => Promise<string>;
  promptText: (message: string) => Promise<string>;
  promptSecret: (message: string) => Promise<string>;
  loginBrowserCredential: typeof loginOAuthBrowser;
  openBrowser: (url: string) => boolean;
  write: (message: string) => void;
}

const defaultDependencies: ProviderAddDependencies = {
  connectDaemon: connectToDaemon,
  readStdin,
  promptText,
  promptSecret,
  loginBrowserCredential: loginOAuthBrowser,
  openBrowser: openBrowserUrl,
  write: (message) => console.error(message),
};

export const providerConfiguredSchema: OutputSchema<ProviderConfiguredItem> = {
  idField: "name",
  columns: [
    { header: "NAME", field: "name", width: 20 },
    { header: "TYPE", field: "providerType", width: 16 },
    { header: "LABEL", field: "label", width: 22 },
    { header: "AUTH", field: "auth", width: 16 },
    { header: "AVAILABLE", field: "available", width: 10 },
    { header: "MODELS", field: "models", width: 50 },
  ],
};

async function readStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let value = "";
  for await (const chunk of process.stdin) {
    value += chunk;
  }
  return value;
}

async function promptText(message: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`${message} `)).trim();
  } finally {
    rl.close();
  }
}

async function promptSecret(message: string): Promise<string> {
  const output = new Writable({
    write(chunk, _encoding, callback) {
      const text = String(chunk);
      if (text.includes(message)) {
        process.stdout.write(text);
      }
      callback();
    },
  }) as Writable & { isTTY?: boolean };
  output.isTTY = true;

  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try {
    return (await rl.question(`${message} `)).trim();
  } finally {
    process.stdout.write("\n");
    rl.close();
  }
}

function authField(entry: PaseoAgentCatalogEntry, field: string): string | undefined {
  const auth = entry.auth;
  const value = auth[field];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function requireAuthField(
  entry: PaseoAgentCatalogEntry,
  field: string,
  description: string,
): string {
  const value = authField(entry, field);
  if (value) return value;

  throw {
    code: "UNSUPPORTED_PROVIDER_AUTH",
    message: `Provider ${entry.id} is missing ${description}. Update the Paseo daemon to use this command.`,
  } satisfies CommandError;
}

function apiKeyEnvVar(entry: PaseoAgentCatalogEntry): string {
  return requireAuthField(entry, "envVar", "an API key environment variable");
}

function oauthFlow(entry: PaseoAgentCatalogEntry): string {
  return requireAuthField(entry, "flow", "an OAuth flow");
}

function normalizeModels(rawModels: string[] | undefined): string[] {
  return (rawModels ?? [])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

function catalogModels(entry: PaseoAgentCatalogEntry): ProviderModelInput[] {
  return entry.models.map((model) => ({
    id: model.id,
    ...(model.label ? { label: model.label } : {}),
    ...(model.api ? { api: model.api } : {}),
    ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
  }));
}

function resolveModels(
  entry: PaseoAgentCatalogEntry,
  options: ProviderAddOptions,
): ProviderModelInput[] | undefined {
  const modelIds = normalizeModels(options.model);
  if (modelIds.length > 0) {
    return modelIds.map((id) => ({ id }));
  }

  const models = catalogModels(entry);
  if (models.length > 0) {
    return models;
  }
  return undefined;
}

async function selectCatalogEntry(
  catalog: PaseoAgentCatalogEntry[],
  dependencies: ProviderAddDependencies,
): Promise<PaseoAgentCatalogEntry> {
  if (catalog.length === 0) {
    throw {
      code: "EMPTY_PROVIDER_CATALOG",
      message: "The Paseo daemon returned an empty provider catalog.",
    } satisfies CommandError;
  }

  dependencies.write("Available model providers:");
  catalog.forEach((entry, index) => {
    dependencies.write(`  ${index + 1}. ${entry.label} (${entry.id})`);
  });
  const answer = await dependencies.promptText("Select provider:");
  const selectedIndex = Number(answer);
  const byIndex = Number.isInteger(selectedIndex) ? catalog[selectedIndex - 1] : undefined;
  const byId = catalog.find((entry) => entry.id === answer);
  const selected = byIndex ?? byId;
  if (selected) {
    return selected;
  }
  throw {
    code: "INVALID_PROVIDER_SELECTION",
    message: `Invalid provider selection: ${answer}`,
  } satisfies CommandError;
}

async function resolveEntry(
  id: string | undefined,
  catalog: PaseoAgentCatalogEntry[],
  dependencies: ProviderAddDependencies,
): Promise<PaseoAgentCatalogEntry> {
  if (!id) {
    return selectCatalogEntry(catalog, dependencies);
  }

  const entry = catalog.find((candidate) => candidate.id === id);
  if (entry) {
    return entry;
  }

  const knownIds = catalog.map((candidate) => candidate.id).join(", ");
  throw {
    code: "UNKNOWN_PROVIDER",
    message: `Unknown model provider type "${id}". Known provider ids: ${knownIds}.`,
  } satisfies CommandError;
}

function formatAuthState(provider: RedactedPaseoAgentProviderConfig): string {
  if (!provider.auth) {
    return "not configured";
  }
  return provider.auth.configured ? "Connected" : "Needs attention";
}

function toConfiguredItem(
  provider: RedactedPaseoAgentProviderConfig,
  entry: PaseoAgentCatalogEntry,
): ProviderConfiguredItem {
  return {
    name: provider.name,
    providerType: provider.providerType,
    label: entry.label,
    auth: formatAuthState(provider),
    available: provider.available ? "yes" : "no",
    models: provider.models.map((model) => model.id).join(", ") || "-",
  };
}

function formatDaemonTarget(host: string | undefined): string {
  if (!host) {
    return "local daemon";
  }
  try {
    if (host.startsWith("tcp://")) {
      const url = new URL(host);
      url.searchParams.delete("password");
      return `selected daemon (${url.toString()})`;
    }
  } catch {
    return `selected daemon (${host})`;
  }
  return `selected daemon (${host})`;
}

async function resolveApiKey(
  entry: PaseoAgentCatalogEntry,
  options: ProviderAddOptions,
  dependencies: ProviderAddDependencies,
): Promise<string> {
  const envVar = apiKeyEnvVar(entry);
  if (options.apiKeyStdin) {
    const value = (await dependencies.readStdin()).trim();
    if (value) {
      return value;
    }
    throw {
      code: "MISSING_API_KEY",
      message: "No API key was read from stdin.",
    } satisfies CommandError;
  }

  const hint = authField(entry, "hint");
  const keyUrl = authField(entry, "keyUrl");
  if (hint) {
    dependencies.write(hint);
  }
  if (keyUrl) {
    dependencies.write(`API key URL: ${keyUrl}`);
  }
  const placeholder = authField(entry, "placeholder") ?? "API key";
  const value = await dependencies.promptSecret(
    `Enter ${placeholder} (leave empty to use $${envVar}):`,
  );
  return value || `$${envVar}`;
}

function isBrowserOpenError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as CommandError).code === "BROWSER_OPEN_FAILED"
  );
}

function printOAuthAuthorization(
  authorization: Awaited<ReturnType<ProviderAddClient["startPaseoAgentOAuth"]>>["authorization"],
  dependencies: ProviderAddDependencies,
): void {
  if (!authorization) {
    dependencies.write("Authorization completed; waiting for the daemon to store credentials...");
    return;
  }
  if (authorization.instructions) {
    dependencies.write(authorization.instructions);
  }
  if (authorization.verificationUri) {
    dependencies.write(`Open: ${authorization.verificationUri}`);
  }
  if (authorization.userCode) {
    dependencies.write(`Code: ${authorization.userCode}`);
  }
  if (authorization.url) {
    dependencies.write(`Open: ${authorization.url}`);
  }
  if (authorization.expiresInSeconds) {
    dependencies.write(
      `Expires in about ${Math.round(authorization.expiresInSeconds / 60)} minutes.`,
    );
  }
  dependencies.write("Waiting for authorization...");
}

async function runDaemonOAuth(
  client: ProviderAddClient,
  name: string,
  dependencies: ProviderAddDependencies,
): Promise<PaseoAgentProviderAuthState | undefined> {
  const started = await client.startPaseoAgentOAuth(name, { mode: "device_code" });
  if (!started.success) {
    throw {
      code: "OAUTH_START_FAILED",
      message: started.error ?? "Daemon rejected the OAuth start request.",
    } satisfies CommandError;
  }
  printOAuthAuthorization(started.authorization, dependencies);
  const completed = await client.completePaseoAgentOAuth(name);
  if (!completed.success) {
    throw {
      code: "OAUTH_COMPLETE_FAILED",
      message: completed.error ?? "Daemon did not complete OAuth.",
    } satisfies CommandError;
  }
  return completed.auth;
}

async function runBrowserOAuth(
  client: ProviderAddClient,
  entry: PaseoAgentCatalogEntry,
  name: string,
  options: ProviderAddOptions,
  dependencies: ProviderAddDependencies,
): Promise<PaseoAgentProviderAuthState | undefined> {
  const target = formatDaemonTarget(options.host);
  const credential: PaseoAgentOAuthCredential = await dependencies.loginBrowserCredential({
    flow: oauthFlow(entry),
    onAuthUrl: (url, instructions) => {
      const opened = dependencies.openBrowser(url);
      if (!opened) {
        throw {
          code: "BROWSER_OPEN_FAILED",
          message: "Browser could not be opened.",
        } satisfies CommandError;
      }
      dependencies.write(instructions ?? "Opening your browser to authorize Paseo.");
      dependencies.write(`  ${url}`);
      dependencies.write("Waiting for you to approve in the browser...");
    },
    onProgress: (message) => dependencies.write(message),
    promptForCode: dependencies.promptText,
  });
  const result = await client.storePaseoAgentOAuthCredential({ name, credential });
  if (!result.success) {
    throw {
      code: "OAUTH_STORE_FAILED",
      message: result.error ?? "Daemon rejected the OAuth credential.",
    } satisfies CommandError;
  }
  dependencies.write(`Credential accepted by ${target}.`);
  return result.auth;
}

async function configureProvider(
  client: ProviderAddClient,
  entry: PaseoAgentCatalogEntry,
  name: string,
  options: ProviderAddOptions,
  dependencies: ProviderAddDependencies,
): Promise<RedactedPaseoAgentProviderConfig> {
  const models = resolveModels(entry, options);
  const apiKey =
    entry.auth.kind === "api_key" ? await resolveApiKey(entry, options, dependencies) : undefined;
  const result = await client.setPaseoAgentProvider({
    name,
    providerType: entry.id,
    options: {
      ...(apiKey ? { apiKey } : {}),
      ...(models ? { models } : {}),
    },
  });
  if (!result.success || !result.provider) {
    throw {
      code: "PROVIDER_CONFIG_FAILED",
      message: result.error ?? "Daemon rejected the provider config.",
    } satisfies CommandError;
  }
  return result.provider;
}

async function authenticateOAuthProvider(
  client: ProviderAddClient,
  entry: PaseoAgentCatalogEntry,
  name: string,
  options: ProviderAddOptions,
  dependencies: ProviderAddDependencies,
): Promise<PaseoAgentProviderAuthState | undefined> {
  if (options.deviceCode) {
    return runDaemonOAuth(client, name, dependencies);
  }
  try {
    return await runBrowserOAuth(client, entry, name, options, dependencies);
  } catch (error) {
    if (!isBrowserOpenError(error)) {
      throw error;
    }
    dependencies.write("Browser could not be opened; using device-code authorization.");
    return runDaemonOAuth(client, name, dependencies);
  }
}

export async function runAddCommand(
  id: string | undefined,
  options: ProviderAddOptions,
  _command: Command,
  dependencies: Partial<ProviderAddDependencies> = {},
): Promise<SingleResult<ProviderConfiguredItem>> {
  const deps = { ...defaultDependencies, ...dependencies };
  const client = await deps.connectDaemon({ host: options.host });
  try {
    await requirePaseoAgentCatalogFeature(client);
    const catalogResult = await client.getPaseoAgentCatalog();
    if (catalogResult.error) {
      throw {
        code: "PROVIDER_CATALOG_FAILED",
        message: catalogResult.error,
      } satisfies CommandError;
    }
    const entry = await resolveEntry(id, catalogResult.catalog, deps);
    const name = options.name?.trim() || entry.id;
    const provider = await configureProvider(client, entry, name, options, deps);
    if (entry.auth.kind !== "api_key" && entry.auth.kind !== "oauth") {
      throw {
        code: "UNSUPPORTED_PROVIDER_AUTH",
        message: `Provider ${entry.label} uses an auth type this CLI does not understand. Update the Paseo daemon to use this command.`,
      } satisfies CommandError;
    }
    const auth =
      entry.auth.kind === "oauth"
        ? await authenticateOAuthProvider(client, entry, name, options, deps)
        : provider.auth;

    return {
      type: "single",
      data: toConfiguredItem(auth ? { ...provider, auth } : provider, entry),
      schema: providerConfiguredSchema,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

export function addProviderAddOptions(command: Command): Command {
  return command
    .description("Configure a Paseo Agent model provider")
    .argument("[id]", "Catalog provider id; omit to choose interactively")
    .option("--name <instanceName>", "Provider instance name (default: provider id)")
    .option(
      "--model <id>",
      "Model ID to expose (repeatable, comma-separated; defaults to catalog models)",
      collectMultiple,
      [],
    )
    .option("--api-key-stdin", "Read API key from stdin")
    .option("--device-code", "Use daemon-run device-code OAuth instead of browser OAuth");
}
