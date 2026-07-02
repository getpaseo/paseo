import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  AuthStorage,
  FileAuthStorageBackend,
  type AuthCredential,
  type AuthStorageBackend,
} from "@earendil-works/pi-coding-agent";
import type {
  OAuthCredentials,
  OAuthDeviceCodeInfo as PiOAuthDeviceCodeInfo,
  OAuthLoginCallbacks,
  OAuthSelectPrompt,
} from "@earendil-works/pi-ai";
import { getOAuthProvider } from "@earendil-works/pi-ai/oauth";
import type { PaseoAgentOAuthCredential } from "@getpaseo/protocol/messages";

// Paseo-owned OAuth credential store for the Paseo Agent provider. Credentials live
// in a Paseo-controlled file and are managed through Pi's own AuthStorage, so Pi
// refreshes tokens and persists rotation back into Paseo's file. Login flows reuse
// Pi's OAuth registry; Paseo does not reimplement OAuth protocols.

export type OAuthDeviceCodeInfo = PiOAuthDeviceCodeInfo;
export type OAuthLogin = (callbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials>;
type OAuthLoginPreference = "browser" | "device";

export interface OAuthCredentialBinding {
  flow: string;
  baseUrl: string;
}

export interface StoredOAuthCredentialState {
  present: boolean;
  bindingMatches: boolean;
}

interface BoundOAuthCredential extends PaseoAgentOAuthCredential {
  binding?: OAuthCredentialBinding;
}

interface StorageLockResult<T> {
  result: T;
  next?: string;
}

/** Path to the Paseo-owned auth store. Uses PASEO_HOME; falls back to ~/.paseo. */
export function paseoAgentAuthStoragePath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.PASEO_HOME ?? join(homedir(), ".paseo");
  return join(base, "paseo-agent", "auth.json");
}

/**
 * Pi AuthStorage backed by the Paseo-owned file. Pi creates the parent dir (0700) and
 * the file (0600) and re-chmods on every write, so refreshed tokens stay private.
 */
export function createPaseoAgentAuthStorage(env: NodeJS.ProcessEnv = process.env): AuthStorage {
  return AuthStorage.create(paseoAgentAuthStoragePath(env));
}

export function createBoundPaseoAgentAuthStorage(
  bindings: Record<string, OAuthCredentialBinding>,
  env: NodeJS.ProcessEnv = process.env,
): AuthStorage {
  return AuthStorage.fromStorage(
    new BindingAwareAuthStorageBackend(paseoAgentAuthStoragePath(env), bindings),
  );
}

/**
 * Read-only check (no file creation) for whether a Paseo-owned OAuth credential exists
 * for a provider instance. Used for availability without constructing AuthStorage.
 */
export function hasStoredOAuthCredential(
  providerInstance: string,
  env: NodeJS.ProcessEnv = process.env,
  binding?: OAuthCredentialBinding,
): boolean {
  const state = getStoredOAuthCredentialState(providerInstance, env, binding);
  return state.present && state.bindingMatches;
}

export function getStoredOAuthCredentialState(
  providerInstance: string,
  env: NodeJS.ProcessEnv = process.env,
  binding?: OAuthCredentialBinding,
): StoredOAuthCredentialState {
  const path = paseoAgentAuthStoragePath(env);
  if (!existsSync(path)) {
    return { present: false, bindingMatches: false };
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      return { present: false, bindingMatches: false };
    }
    const entry = (parsed as Record<string, unknown>)[providerInstance];
    if (!isOAuthCredentialRecord(entry)) {
      return { present: false, bindingMatches: false };
    }
    return { present: true, bindingMatches: !binding || bindingsEqual(entry.binding, binding) };
  } catch {
    return { present: false, bindingMatches: false };
  }
}

/**
 * Store a credential obtained by a remote-safe client-side OAuth flow into the
 * daemon's Paseo-owned AuthStorage. The caller supplies the protocol credential
 * shape, and this helper never reads or writes foreign auth files.
 */
export function storeOAuthCredential(options: {
  providerInstance: string;
  credential: PaseoAgentOAuthCredential;
  binding: OAuthCredentialBinding;
  env?: NodeJS.ProcessEnv;
}): { path: string } {
  const path = paseoAgentAuthStoragePath(options.env);
  const authStorage = AuthStorage.create(path);
  authStorage.set(options.providerInstance, {
    ...options.credential,
    binding: { ...options.binding },
  });
  return { path };
}

export async function loginAndStoreOAuth(options: {
  flow: string;
  baseUrl: string;
  providerInstance: string;
  onDeviceCode: (info: OAuthDeviceCodeInfo) => void;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  login?: OAuthLogin;
}): Promise<{ path: string }> {
  const credential = await loginOAuthDevice({
    flow: options.flow,
    onDeviceCode: options.onDeviceCode,
    signal: options.signal,
    login: options.login,
  });
  return storeOAuthCredential({
    providerInstance: options.providerInstance,
    credential,
    binding: { flow: options.flow, baseUrl: options.baseUrl },
    env: options.env,
  });
}

export async function loginOAuthDevice(options: {
  flow: string;
  onDeviceCode: (info: OAuthDeviceCodeInfo) => void;
  signal?: AbortSignal;
  login?: OAuthLogin;
}): Promise<PaseoAgentOAuthCredential> {
  const login = resolveOAuthLogin(options.flow, options.login);
  const credentials = await login({
    onAuth: () => {},
    onDeviceCode: options.onDeviceCode,
    onPrompt: async () => {
      throw new Error("OAuth login requested manual input, but no prompt handler is available.");
    },
    onSelect: (prompt) => selectOAuthOption(prompt, "device"),
    signal: options.signal,
  });
  return { type: "oauth", ...credentials };
}

export async function loginOAuthBrowser(options: {
  flow: string;
  onAuthUrl: (url: string, instructions?: string) => void;
  promptForCode?: (message: string) => Promise<string>;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
  login?: OAuthLogin;
}): Promise<PaseoAgentOAuthCredential> {
  const login = resolveOAuthLogin(options.flow, options.login);
  const credentials = await login({
    onAuth: (info) => options.onAuthUrl(info.url, info.instructions),
    onDeviceCode: () => {},
    onProgress: options.onProgress,
    onPrompt: async (prompt) => {
      if (!options.promptForCode) {
        throw new Error("Browser login did not complete and no manual code entry was available.");
      }
      return options.promptForCode(prompt.message);
    },
    onSelect: (prompt) => selectOAuthOption(prompt, "browser"),
    signal: options.signal,
  });
  return { type: "oauth", ...credentials };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOAuthCredentialRecord(value: unknown): value is BoundOAuthCredential {
  return isRecord(value) && value.type === "oauth";
}

function bindingsEqual(
  actual: OAuthCredentialBinding | undefined,
  expected: OAuthCredentialBinding,
): boolean {
  return actual?.flow === expected.flow && actual.baseUrl === expected.baseUrl;
}

function credentialBinding(
  credential: AuthCredential | undefined,
): OAuthCredentialBinding | undefined {
  if (!credential || credential.type !== "oauth") {
    return undefined;
  }
  const binding = credential.binding;
  if (!isRecord(binding)) {
    return undefined;
  }
  return typeof binding.flow === "string" && typeof binding.baseUrl === "string"
    ? { flow: binding.flow, baseUrl: binding.baseUrl }
    : undefined;
}

function parseAuthStorageData(current: string | undefined): Record<string, AuthCredential> {
  if (!current) {
    return {};
  }
  const parsed: unknown = JSON.parse(current);
  return isRecord(parsed) ? (parsed as Record<string, AuthCredential>) : {};
}

function serializeAuthStorageData(data: Record<string, AuthCredential>): string {
  return JSON.stringify(data, null, 2);
}

function filterBoundCredentials(
  data: Record<string, AuthCredential>,
  bindings: Record<string, OAuthCredentialBinding>,
): Record<string, AuthCredential> {
  const filtered: Record<string, AuthCredential> = {};
  for (const [provider, credential] of Object.entries(data)) {
    const binding = bindings[provider];
    if (
      !binding ||
      credential.type !== "oauth" ||
      bindingsEqual(credentialBinding(credential), binding)
    ) {
      filtered[provider] = credential;
    }
  }
  return filtered;
}

function mergeBindingAwareWrite(
  original: Record<string, AuthCredential>,
  visible: Record<string, AuthCredential>,
  next: string,
): string {
  const nextData = parseAuthStorageData(next);
  const merged: Record<string, AuthCredential> = { ...original };
  for (const provider of Object.keys(visible)) {
    if (!Object.prototype.hasOwnProperty.call(nextData, provider)) {
      delete merged[provider];
    }
  }
  for (const [provider, credential] of Object.entries(nextData)) {
    const originalBinding = credentialBinding(original[provider]);
    if (credential.type === "oauth" && !credential.binding && originalBinding) {
      merged[provider] = { ...credential, binding: originalBinding };
    } else {
      merged[provider] = credential;
    }
  }
  return serializeAuthStorageData(merged);
}

class BindingAwareAuthStorageBackend implements AuthStorageBackend {
  private readonly delegate: FileAuthStorageBackend;
  private readonly bindings: Record<string, OAuthCredentialBinding>;

  constructor(path: string, bindings: Record<string, OAuthCredentialBinding>) {
    this.delegate = new FileAuthStorageBackend(path);
    this.bindings = bindings;
  }

  withLock<T>(fn: (current: string | undefined) => StorageLockResult<T>): T {
    return this.delegate.withLock((current) => {
      const original = parseAuthStorageData(current);
      const visible = filterBoundCredentials(original, this.bindings);
      const result = fn(serializeAuthStorageData(visible));
      return {
        result: result.result,
        ...(result.next !== undefined
          ? { next: mergeBindingAwareWrite(original, visible, result.next) }
          : {}),
      };
    });
  }

  withLockAsync<T>(fn: (current: string | undefined) => Promise<StorageLockResult<T>>): Promise<T> {
    return this.delegate.withLockAsync(async (current) => {
      const original = parseAuthStorageData(current);
      const visible = filterBoundCredentials(original, this.bindings);
      const result = await fn(serializeAuthStorageData(visible));
      return {
        result: result.result,
        ...(result.next !== undefined
          ? { next: mergeBindingAwareWrite(original, visible, result.next) }
          : {}),
      };
    });
  }
}

function resolveOAuthLogin(flow: string, login: OAuthLogin | undefined): OAuthLogin {
  if (login) {
    return login;
  }
  const provider = getOAuthProvider(flow);
  if (!provider) {
    throw new Error(`Paseo Agent: OAuth flow "${flow}" is not registered by Pi.`);
  }
  return (callbacks) => provider.login(callbacks);
}

function selectOAuthOption(
  prompt: OAuthSelectPrompt,
  preference: OAuthLoginPreference,
): Promise<string | undefined> {
  const preferred = prompt.options.find((option) =>
    option.label.toLowerCase().includes(preference),
  );
  return Promise.resolve((preferred ?? prompt.options[0])?.id);
}
