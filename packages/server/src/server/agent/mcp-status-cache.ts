import type { AgentMcpReport } from "./agent-sdk-types.js";

/**
 * Per-agent cache for MCP status reports, with concurrent calls coalesced.
 *
 * The cost of a report is wildly uneven: Claude answers in about 3ms, Codex in about
 * 3.5 seconds because `mcpServerStatus/list` returns every server's full tool schemas.
 * The client caches too, but a client-side cache does nothing for a second device, a
 * reconnect, or two panels open at once — each of those is another 3.5 seconds and
 * another megabyte through the same app-server connection the agent runs turns on.
 *
 * MCP connections settle when an agent starts and rarely move afterwards, so a short
 * window costs accuracy that the refresh control can buy back on demand.
 */
const DEFAULT_TTL_MS = 30_000;

interface CacheEntry {
  report: AgentMcpReport;
  storedAtMs: number;
  fetchedAt: string;
}

/** A report plus when the provider actually produced it, which a cache hit preserves. */
export interface CachedMcpReport {
  report: AgentMcpReport;
  fetchedAt: string;
}

export class McpStatusCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<CachedMcpReport>>();

  constructor(
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * `force` skips the cached value but still joins an in-flight call — a user hitting
   * refresh twice should not start a second 3.5-second fetch, and neither should two
   * clients refreshing at once.
   */
  async read(
    agentId: string,
    force: boolean,
    load: () => Promise<AgentMcpReport>,
  ): Promise<CachedMcpReport> {
    const pending = this.inFlight.get(agentId);
    if (pending) return pending;

    if (!force) {
      const entry = this.entries.get(agentId);
      if (entry && this.now() - entry.storedAtMs < this.ttlMs) {
        // The stored timestamp, not the current one: a half-minute-old cache hit that
        // claimed it was fetched just now would misrepresent how current it is.
        return { report: entry.report, fetchedAt: entry.fetchedAt };
      }
    }

    const request = load()
      .then((report) => {
        const storedAtMs = this.now();
        const fetchedAt = new Date(storedAtMs).toISOString();
        this.entries.set(agentId, { report, storedAtMs, fetchedAt });
        return { report, fetchedAt };
      })
      .finally(() => {
        this.inFlight.delete(agentId);
      });
    this.inFlight.set(agentId, request);
    return request;
  }

  /** Drop an agent's cached report — its runtime restarted, so the servers may differ. */
  invalidate(agentId: string): void {
    this.entries.delete(agentId);
  }
}
