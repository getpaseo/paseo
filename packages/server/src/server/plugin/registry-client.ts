import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  PluginRegistryEntrySchema,
  PluginRegistryIndexEnvelopeSchema,
  type PluginRegistryEntry,
  type PluginRegistryIndex,
} from "@getpaseo/protocol/plugin/types";

/** Total verified bytes a single install is allowed to write. */
export const PLUGIN_INSTALL_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
/**
 * Hard ceiling on any single body the daemon reads from the registry. The
 * registry operator is a trust boundary (SECURITY.md), so an HTTP response is
 * aborted mid-stream rather than buffered and measured afterwards. The `file://`
 * path reads whole and checks after, which is the developer case and a local
 * file the daemon user already owns.
 */
export const PLUGIN_REGISTRY_MAX_RESPONSE_BYTES = PLUGIN_INSTALL_MAX_TOTAL_BYTES;
const DEFAULT_INDEX_CACHE_TTL_MS = 5 * 60_000;
/** Per-request ceiling, well inside the client's own 120s RPC timeout. */
const REGISTRY_REQUEST_TIMEOUT_MS = 30_000;

/**
 * The registry's transport, injected so tests drive install and browse against
 * an in-memory index instead of the network.
 */
export interface PluginRegistryHttp {
  getJson(url: string): Promise<unknown>;
  /**
   * `maxBytes` is a hard ceiling the transport enforces while reading, not a
   * check after the fact — a hostile registry must not be able to fill the heap.
   */
  getBytes(url: string, options?: { maxBytes?: number }): Promise<Uint8Array>;
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
  /** Called when an entry is dropped, so a publisher's vanished listing has a reason somewhere. */
  onEntryDropped?: (input: { pluginId: unknown; reason: string }) => void;
}

/**
 * Production transport. `file://` is supported so a developer can point
 * `daemon.plugins.registryUrl` at a local index; `fetch` does not read it.
 */
export function createFetchPluginRegistryHttp(): PluginRegistryHttp {
  async function read(url: string, maxBytes: number): Promise<Uint8Array> {
    const cap = Math.min(maxBytes, PLUGIN_REGISTRY_MAX_RESPONSE_BYTES);
    // Off the parsed URL, the same way the config and the per-file allowlist
    // decide. A `startsWith("file://")` here disagreed with both about
    // `file:/tmp/index.json`, which is a valid file URL they accept — it fell
    // through to `fetch`, which does not implement the scheme, so a config that
    // validated failed at Browse time with "fetch failed".
    if (protocolOf(url) === "file:") {
      const bytes = new Uint8Array(await readFile(fileURLToPath(url)));
      if (bytes.byteLength > cap) {
        throw new Error(`${url} is larger than the ${cap} byte limit`);
      }
      return bytes;
    }
    // Bounded, because a registry host that accepts the connection and then
    // says nothing otherwise leaves this promise pending forever: the RPC never
    // answers and the client sits there until its own 120s timeout.
    const response = await fetch(url, { signal: AbortSignal.timeout(REGISTRY_REQUEST_TIMEOUT_MS) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && Number(declared) > cap) {
      throw new Error(`${url} declares ${declared} bytes, over the ${cap} byte limit`);
    }
    return readCapped(response, url, cap);
  }

  return {
    async getJson(url) {
      // The cap is stated here rather than left to `read`'s own clamp: the index
      // has no per-file size to go on, so this call site is the one that decides.
      return JSON.parse(
        new TextDecoder().decode(await read(url, PLUGIN_REGISTRY_MAX_RESPONSE_BYTES)),
      );
    },
    async getBytes(url, options) {
      return read(url, options?.maxBytes ?? Number.POSITIVE_INFINITY);
    },
  };
}

/** Reads a response body, aborting the transfer as soon as it passes `cap`. */
async function readCapped(response: Response, url: string, cap: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    return new Uint8Array();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw new Error(`${url} exceeds the ${cap} byte limit`);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
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
 * Reads the registry index and downloads plugin files, verifying every byte
 * against the index before the caller is allowed to write anything.
 */
export class PluginRegistryClient {
  private readonly http: PluginRegistryHttp;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly maxTotalBytes: number;
  private readonly onEntryDropped: PluginRegistryClientOptions["onEntryDropped"];
  private cache: { index: PluginRegistryIndex; fetchedAt: number } | null = null;

  readonly registryUrl: string;

  constructor(options: PluginRegistryClientOptions) {
    this.registryUrl = options.registryUrl;
    this.http = options.http;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_INDEX_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
    this.maxTotalBytes = options.maxTotalBytes ?? PLUGIN_INSTALL_MAX_TOTAL_BYTES;
    this.onEntryDropped = options.onEntryDropped;
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

    const envelope = PluginRegistryIndexEnvelopeSchema.safeParse(raw);
    if (!envelope.success) {
      throw new PluginRegistryUnavailableError(this.registryUrl, "index did not parse");
    }

    // Per entry, so one malformed plugin costs that plugin its listing rather
    // than taking the whole registry offline.
    const index: PluginRegistryIndex = {
      version: envelope.data.version,
      plugins: envelope.data.plugins.flatMap((entry) => {
        const parsed = PluginRegistryEntrySchema.safeParse(entry);
        if (parsed.success) {
          return [parsed.data];
        }
        // Reported, because the publisher's plugin just vanished from the
        // listing and the reason lives in a schema they cannot see.
        this.onEntryDropped?.({
          pluginId: (entry as { manifest?: { id?: unknown } })?.manifest?.id,
          reason: parsed.error.issues.map((issue) => issue.message).join("; "),
        });
        return [];
      }),
    };
    this.cache = { index, fetchedAt: this.now() };
    return index;
  }

  clearCache(): void {
    this.cache = null;
  }

  /**
   * Fetches every file of a plugin and verifies it. Resolves only when all of
   * them matched, so a partial install cannot land.
   */
  async download(pluginId: string, options?: { refresh?: boolean }): Promise<PluginDownload> {
    const index = await this.browse(options);
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

    // Two files under one name both verify, and the second write silently wins —
    // so the entry that ships is not the one whose hashes were checked. The
    // schema's `.max(64)` bounds the count, not the names.
    const names = new Set(entry.files.map((file) => file.name));
    if (names.size !== entry.files.length) {
      throw new PluginDownloadRejectedError(pluginId, "the index lists the same file twice");
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
        // The index's own claim is the ceiling, and the transport enforces it
        // while reading: a CDN that streams gigabytes for a file declared at a
        // kilobyte is aborted instead of buffered.
        bytes = await this.http.getBytes(file.url, { maxBytes: file.bytes });
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
