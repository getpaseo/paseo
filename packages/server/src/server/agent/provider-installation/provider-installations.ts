import type { Logger } from "pino";
import type {
  ProviderInstallation,
  ProviderInstallationInspection,
} from "@getpaseo/protocol/messages";
import { ProviderInspectionSchema } from "@getpaseo/plugin/server/provider";
import type { AgentClient, AgentClientInstallation, AgentProvider } from "../agent-sdk-types.js";

const DEFAULT_INSPECT_TIMEOUT_MS = 20_000;
const DEFAULT_INSPECT_CACHE_MS = 30_000;

export interface ProviderInstallationsOptions {
  logger: Logger;
  /** The current client for a configured provider, or null when the provider is unknown. */
  resolveClient(provider: AgentProvider): AgentClient | null;
  inspectTimeoutMs?: number;
  inspectCacheMs?: number;
  now?: () => number;
}

export interface InspectProviderInstallationOptions {
  /** Skip the settled-result cache. Joins a call that is already running. */
  refresh?: boolean;
}

interface InspectionRead {
  promise: Promise<ProviderInstallationInspection>;
  settledAt: number | null;
}

type InspectCallback = NonNullable<AgentClientInstallation["inspect"]>;

/**
 * Calls provider installation callbacks for every provider, built-in or plugin, through
 * `AgentClient.installation`. Owns deadlines, in-flight sharing and result caching. Results are
 * keyed by client, so a provider configuration change, which replaces the client, starts fresh.
 */
export class ProviderInstallations {
  private readonly logger: Logger;
  private readonly resolveClient: ProviderInstallationsOptions["resolveClient"];
  private readonly inspectTimeoutMs: number;
  private readonly inspectCacheMs: number;
  private readonly now: () => number;
  private readonly inspections = new WeakMap<AgentClient, InspectionRead>();

  constructor(options: ProviderInstallationsOptions) {
    this.logger = options.logger;
    this.resolveClient = options.resolveClient;
    this.inspectTimeoutMs = options.inspectTimeoutMs ?? DEFAULT_INSPECT_TIMEOUT_MS;
    this.inspectCacheMs = options.inspectCacheMs ?? DEFAULT_INSPECT_CACHE_MS;
    this.now = options.now ?? Date.now;
  }

  /** Links and installed state, or null when the provider declares no installation contract. */
  async inspect(
    provider: AgentProvider,
    options: InspectProviderInstallationOptions = {},
  ): Promise<ProviderInstallation | null> {
    const client = this.resolveClient(provider);
    if (!client) throw new Error(`Provider ${provider} is not configured`);
    const installation = client.installation;
    if (!installation) return null;
    const result: ProviderInstallation = {};
    if (installation.installUrl) result.installUrl = installation.installUrl;
    if (installation.updateUrl) result.updateUrl = installation.updateUrl;
    if (installation.inspect) {
      result.inspection = await this.readInspection(
        provider,
        client,
        installation.inspect.bind(installation),
        options,
      );
    }
    return result;
  }

  private readInspection(
    provider: AgentProvider,
    client: AgentClient,
    inspect: InspectCallback,
    options: InspectProviderInstallationOptions,
  ): Promise<ProviderInstallationInspection> {
    const existing = this.inspections.get(client);
    if (existing && (existing.settledAt === null || (!options.refresh && this.isFresh(existing)))) {
      return existing.promise;
    }
    // callInspect settles asynchronously, after `read` is initialized.
    const promise = this.callInspect(provider, inspect).then((inspection) => {
      read.settledAt = this.now();
      return inspection;
    });
    const read: InspectionRead = { promise, settledAt: null };
    this.inspections.set(client, read);
    return read.promise;
  }

  private isFresh(read: InspectionRead): boolean {
    return read.settledAt !== null && this.now() - read.settledAt < this.inspectCacheMs;
  }

  private async callInspect(
    provider: AgentProvider,
    inspect: InspectCallback,
  ): Promise<ProviderInstallationInspection> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`Timed out after ${this.inspectTimeoutMs}ms`);
        reject(error);
        controller.abort(error);
      }, this.inspectTimeoutMs);
    });
    try {
      const result = await Promise.race([inspect({ signal: controller.signal }), deadline]);
      return ProviderInspectionSchema.parse(result);
    } catch (error) {
      this.logger.warn({ err: error, provider }, "Provider installation inspect failed");
      return { status: "error", message: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  }
}
