import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  PluginRegistryIndexSchema,
  type PluginRegistryEntry,
  type PluginRegistryIndex,
} from "@getpaseo/protocol/plugin/types";

/** Total verified bytes a single install is allowed to write. */
export const PLUGIN_INSTALL_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const DEFAULT_INDEX_CACHE_TTL_MS = 5 * 60_000;

/**
 * The registry's transport, injected so tests drive install and browse against
 * an in-memory index instead of the network.
 */
export interface PluginRegistryHttp {
  getJson(url: string): Promise<unknown>;
  getBytes(url: string): Promise<Uint8Array>;
}

/** The registry index could not be fetched or did not parse. */
export class PluginRegistryUnavailableError extends Error {
  constructor(
    public readonly registryUrl: string,
    public readonly reason: string,
  ) {
    super(`Plugin registry ${registryUrl} is unavailable: ${reason}`);
    this.name = "PluginRegistryUnavailableError";
  }
}

/** The registry index parsed but does not list the requested plugin. */
export class PluginNotInRegistryError extends Error {
  constructor(
    public readonly pluginId: string,
    public readonly registryUrl: string,
  ) {
    super(`Plugin "${pluginId}" is not listed in ${registryUrl}`);
    this.name = "PluginNotInRegistryError";
  }
}

/**
 * A downloaded file did not match the index. The install is abandoned before
 * anything is written.
 */
export class PluginDownloadVerificationError extends Error {
  constructor(
    public readonly pluginId: string,
    public readonly file: string,
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(
      `Plugin "${pluginId}" file "${file}" failed verification (expected ${expected}, got ${actual})`,
    );
    this.name = "PluginDownloadVerificationError";
  }
}

/** A registry entry asked for something the daemon refuses to fetch or write. */
export class PluginDownloadRejectedError extends Error {
  constructor(
    public readonly pluginId: string,
    public readonly reason: string,
  ) {
    super(`Refused to install "${pluginId}": ${reason}`);
    this.name = "PluginDownloadRejectedError";
  }
}

export interface PluginDownload {
  entry: PluginRegistryEntry;
  files: Array<{ name: string; bytes: Uint8Array }>;
}

export interface PluginRegistryClientOptions {
  registryUrl: string;
  http: PluginRegistryHttp;
  cacheTtlMs?: number;
  now?: () => number;
  maxTotalBytes?: number;
}

/**
 * Production transport. `file://` is supported so a developer can point
 * `daemon.plugins.registryUrl` at a local index; `fetch` does not read it.
 */
export function createFetchPluginRegistryHttp(): PluginRegistryHttp {
  async function read(url: string): Promise<Uint8Array> {
    if (url.startsWith("file://")) {
      return new Uint8Array(await readFile(fileURLToPath(url)));
    }
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  return {
    async getJson(url) {
      return JSON.parse(new TextDecoder().decode(await read(url)));
    },
    getBytes: read,
  };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function protocolOf(url: string): string | null {
  try {
    return new URL(url).protocol;
  } catch {
    return null;
  }
}

/**
 * Reads the marketplace index and downloads plugin files, verifying every byte
 * against the index before the caller is allowed to write anything.
 */
export class PluginRegistryClient {
  private readonly http: PluginRegistryHttp;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly maxTotalBytes: number;
  private cache: { index: PluginRegistryIndex; fetchedAt: number } | null = null;

  readonly registryUrl: string;

  constructor(options: PluginRegistryClientOptions) {
    this.registryUrl = options.registryUrl;
    this.http = options.http;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_INDEX_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
    this.maxTotalBytes = options.maxTotalBytes ?? PLUGIN_INSTALL_MAX_TOTAL_BYTES;
  }

  async browse(options?: { refresh?: boolean }): Promise<PluginRegistryIndex> {
    const cached = this.cache;
    if (!options?.refresh && cached && this.now() - cached.fetchedAt < this.cacheTtlMs) {
      return cached.index;
    }

    let raw: unknown;
    try {
      raw = await this.http.getJson(this.registryUrl);
    } catch (error) {
      throw new PluginRegistryUnavailableError(
        this.registryUrl,
        error instanceof Error ? error.message : String(error),
      );
    }

    const parsed = PluginRegistryIndexSchema.safeParse(raw);
    if (!parsed.success) {
      throw new PluginRegistryUnavailableError(this.registryUrl, "index did not parse");
    }
    this.cache = { index: parsed.data, fetchedAt: this.now() };
    return parsed.data;
  }

  clearCache(): void {
    this.cache = null;
  }

  /**
   * Fetches every file of a plugin and verifies it. Resolves only when all of
   * them matched, so a partial install cannot land.
   */
  async download(pluginId: string): Promise<PluginDownload> {
    const index = await this.browse();
    const entry = index.plugins.find((candidate) => candidate.manifest.id === pluginId);
    if (!entry) {
      throw new PluginNotInRegistryError(pluginId, this.registryUrl);
    }

    const contributed = [
      ...(entry.manifest.contributes.filePreviews ?? []),
      ...(entry.manifest.contributes.sidebarPanels ?? []),
    ].map((contribution) => contribution.entry);
    const missing = contributed.find((name) => !entry.files.some((file) => file.name === name));
    if (missing) {
      throw new PluginDownloadRejectedError(
        pluginId,
        `the index does not list the contributed entry "${missing}"`,
      );
    }

    const declaredBytes = entry.files.reduce((total, file) => total + file.bytes, 0);
    if (declaredBytes > this.maxTotalBytes) {
      throw new PluginDownloadRejectedError(
        pluginId,
        `declared size ${declaredBytes} exceeds the ${this.maxTotalBytes} byte limit`,
      );
    }

    const allowFileUrls = protocolOf(this.registryUrl) === "file:";
    const files: Array<{ name: string; bytes: Uint8Array }> = [];
    for (const file of entry.files) {
      const protocol = protocolOf(file.url);
      if (protocol !== "https:" && !(allowFileUrls && protocol === "file:")) {
        throw new PluginDownloadRejectedError(
          pluginId,
          `file "${file.name}" is served over ${protocol ?? "an unparseable URL"}, https is required`,
        );
      }

      let bytes: Uint8Array;
      try {
        bytes = await this.http.getBytes(file.url);
      } catch (error) {
        throw new PluginDownloadRejectedError(
          pluginId,
          `failed to download "${file.name}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (bytes.byteLength !== file.bytes) {
        throw new PluginDownloadVerificationError(
          pluginId,
          file.name,
          `${file.bytes} bytes`,
          `${bytes.byteLength} bytes`,
        );
      }
      const digest = sha256Hex(bytes);
      if (digest !== file.sha256) {
        throw new PluginDownloadVerificationError(pluginId, file.name, file.sha256, digest);
      }
      files.push({ name: file.name, bytes });
    }

    return { entry, files };
  }
}
