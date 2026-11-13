import type { Logger } from "pino";
import type {
  ProviderInstallation,
  ProviderInstallationInspection,
  ProviderInstallationUpdateCheck,
} from "@getpaseo/protocol/messages";
import {
  ProviderInspectionSchema,
  ProviderUpdateCheckSchema,
} from "@getpaseo/plugin/server/provider";
import type {
  AgentClient,
  AgentClientInstallationContext,
  AgentProvider,
} from "../agent-sdk-types.js";

const DEFAULT_INSPECT_TIMEOUT_MS = 20_000;
const DEFAULT_INSPECT_CACHE_MS = 30_000;
// Below the plugin RPC timeout, so a slow plugin check reports this deadline.
const DEFAULT_UPDATE_CHECK_TIMEOUT_MS = 25_000;
const DEFAULT_UPDATE_CHECK_CACHE_MS = 60 * 60_000;

export interface ProviderInstallationsOptions {
  logger: Logger;
  /** The current client for a configured provider, or null when the provider is unknown. */
  resolveClient(provider: AgentProvider): AgentClient | null;
  inspectTimeoutMs?: number;
  inspectCacheMs?: number;
  updateCheckTimeoutMs?: number;
  /** How long a conclusive update check is reused. Failed checks use `inspectCacheMs`. */
  updateCheckCacheMs?: number;
  now?: () => number;
}

export interface InspectProviderInstallationOptions {
  /** Skip the settled-result cache. Joins a call that is already running. */
  refresh?: boolean;
}

/** A wire result: the provider's answer, or the `failed` value when the call threw or timed out. */
interface ProviderCallResult {
  status: string;
}

interface ProviderCall<T extends ProviderCallResult> {
  name: string;
  /** Validates the provider's answer; throws when it breaks the contract. */
  parse(value: unknown): T;
  timeoutMs: number;
  /** How long a settled result is reused. */
  cacheMs(result: T): number;
  run(context: AgentClientInstallationContext): Promise<unknown>;
  failed(message: string): T;
}

interface CachedRead<T> {
  promise: Promise<T>;
  settledAt: number | null;
  cacheMs: number;
}

/**
 * Calls provider installation callbacks for every provider, built-in or plugin, through
 * `AgentClient.installation`. Owns deadlines, in-flight sharing and result caching. Results are
 * keyed by client, so a provider configuration change, which replaces the client, starts fresh.
 * Inspection and update checks are cached separately so the installed version never waits on an
 * update check.
 */
export class ProviderInstallations {
  private readonly logger: Logger;
  private readonly resolveClient: ProviderInstallationsOptions["resolveClient"];
  private readonly inspectTimeoutMs: number;
  private readonly inspectCacheMs: number;
  private readonly updateCheckTimeoutMs: number;
  private readonly updateCheckCacheMs: number;
  private readonly now: () => number;
  private readonly inspections = new WeakMap<
    AgentClient,
    CachedRead<ProviderInstallationInspection>
  >();
  private readonly updateChecks = new WeakMap<
    AgentClient,
    CachedRead<ProviderInstallationUpdateCheck>
  >();

  constructor(options: ProviderInstallationsOptions) {
    this.logger = options.logger;
    this.resolveClient = options.resolveClient;
    this.inspectTimeoutMs = options.inspectTimeoutMs ?? DEFAULT_INSPECT_TIMEOUT_MS;
    this.inspectCacheMs = options.inspectCacheMs ?? DEFAULT_INSPECT_CACHE_MS;
    this.updateCheckTimeoutMs = options.updateCheckTimeoutMs ?? DEFAULT_UPDATE_CHECK_TIMEOUT_MS;
    this.updateCheckCacheMs = options.updateCheckCacheMs ?? DEFAULT_UPDATE_CHECK_CACHE_MS;
    this.now = options.now ?? Date.now;
  }

  /** Links and installed state, or null when the provider declares no installation contract. */
  async inspect(
    provider: AgentProvider,
    options: InspectProviderInstallationOptions = {},
  ): Promise<ProviderInstallation | null> {
    const client = this.requireClient(provider);
    const installation = client.installation;
    if (!installation) return null;
    const result: ProviderInstallation = {};
    if (installation.installUrl) result.installUrl = installation.installUrl;
    if (installation.updateUrl) result.updateUrl = installation.updateUrl;
    const inspect = installation.inspect;
    if (inspect) {
      result.inspection = await this.read(provider, client, this.inspections, options, {
        name: "inspect",
        parse: (value) => ProviderInspectionSchema.parse(value),
        timeoutMs: this.inspectTimeoutMs,
        cacheMs: () => this.inspectCacheMs,
        run: (context) => inspect.call(installation, context),
        failed: (message) => ({ status: "error" as const, message }),
      });
    }
    return result;
  }

  /**
   * Whether a newer version is available, as the provider reports it, or null when the provider
   * cannot check. A check that throws or misses its deadline is reported as `error`.
   */
  async checkForUpdates(
    provider: AgentProvider,
    options: InspectProviderInstallationOptions = {},
  ): Promise<ProviderInstallationUpdateCheck | null> {
    const client = this.requireClient(provider);
    const installation = client.installation;
    const checkForUpdates = installation?.checkForUpdates;
    if (!installation || !checkForUpdates) return null;
    return this.read(provider, client, this.updateChecks, options, {
      name: "update check",
      parse: (value) => ProviderUpdateCheckSchema.parse(value),
      timeoutMs: this.updateCheckTimeoutMs,
      // Inconclusive answers are retried soon; a conclusive one holds for the long cache.
      cacheMs: (result) =>
        result.status === "current" || result.status === "available"
          ? this.updateCheckCacheMs
          : this.inspectCacheMs,
      run: (context) => checkForUpdates.call(installation, context),
      failed: (message) => ({ status: "error" as const, message }),
    });
  }

  private requireClient(provider: AgentProvider): AgentClient {
    const client = this.resolveClient(provider);
    if (!client) throw new Error(`Provider ${provider} is not configured`);
    return client;
  }

  private read<T extends ProviderCallResult>(
    provider: AgentProvider,
    client: AgentClient,
    cache: WeakMap<AgentClient, CachedRead<T>>,
    options: InspectProviderInstallationOptions,
    call: ProviderCall<T>,
  ): Promise<T> {
    const existing = cache.get(client);
    if (existing && (existing.settledAt === null || (!options.refresh && this.isFresh(existing)))) {
      return existing.promise;
    }
    // invoke settles asynchronously, after `read` is initialized.
    const promise = this.invoke(provider, call).then((result) => {
      read.settledAt = this.now();
      read.cacheMs = call.cacheMs(result);
      return result;
    });
    const read: CachedRead<T> = { promise, settledAt: null, cacheMs: 0 };
    cache.set(client, read);
    return read.promise;
  }

  private isFresh(read: CachedRead<unknown>): boolean {
    return read.settledAt !== null && this.now() - read.settledAt < read.cacheMs;
  }

  private async invoke<T extends ProviderCallResult>(
    provider: AgentProvider,
    call: ProviderCall<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`Timed out after ${call.timeoutMs}ms`);
        reject(error);
        controller.abort(error);
      }, call.timeoutMs);
    });
    try {
      const result = await Promise.race([call.run({ signal: controller.signal }), deadline]);
      return call.parse(result);
    } catch (error) {
      this.logger.warn({ err: error, provider }, `Provider installation ${call.name} failed`);
      return call.failed(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
  }
}
