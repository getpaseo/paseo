import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ForkAgentSource } from "@/hooks/use-fork-agent";
import { toErrorMessage } from "@/utils/error-messages";

/** The non-null payload shape returned by `DaemonClient.fetchAgent`. */
export type FetchedAgentResult = NonNullable<Awaited<ReturnType<DaemonClient["fetchAgent"]>>>;

export type ForkAgentSourceResolution =
  | { kind: "resolved"; agent: ForkAgentSource }
  /** No connected client to fetch a missing record from. */
  | { kind: "disconnected" }
  /** The daemon is reachable and says this agent does not exist. */
  | { kind: "not_found" }
  /** The lookup failed for a transient reason (socket, timeout, ...). */
  | { kind: "error"; message: string };

export interface ResolveForkAgentSourceInput {
  agentId: string;
  /**
   * Lazy on purpose: the caller reads the session store at invoke time so the
   * tab strip never subscribes to agent records it only needs when forking.
   */
  readAgent: () => ForkAgentSource | null | undefined;
  /**
   * `null` when there is no connected client. Kept as an injected thunk rather
   * than a `DaemonClient` so this module stays unit-testable.
   */
  fetchAgent: ((agentId: string) => Promise<FetchedAgentResult | null>) | null;
  /** Hydrates the fetched payload into the session store and returns the record. */
  storeAgent: (result: FetchedAgentResult) => ForkAgentSource;
}

/**
 * Mirrors the not-found classification in `agent-panel.tsx`, which owns the
 * other missing-agent resolution path.
 */
export function isAgentNotFoundErrorMessage(message: string): boolean {
  return /not found/i.test(message);
}

/**
 * Resolves the agent record a fork needs to seed its draft.
 *
 * A persisted/restored agent tab can outlive its record in both `agents` and
 * `agentDetails` (for example a tab restored on startup before the record is
 * hydrated). The agent still exists on the daemon and is perfectly forkable, so
 * fall back to `fetchAgent` instead of failing the fork outright.
 *
 * The connectivity gate deliberately lives *after* the store read: when the
 * record is present the fork proceeds exactly as before, and `useForkAgent`
 * keeps ownership of its own missing-client error.
 */
export async function resolveForkAgentSource(
  input: ResolveForkAgentSourceInput,
): Promise<ForkAgentSourceResolution> {
  const existing = input.readAgent();
  if (existing) {
    return { kind: "resolved", agent: existing };
  }

  if (!input.fetchAgent) {
    return { kind: "disconnected" };
  }

  let result: FetchedAgentResult | null;
  try {
    result = await input.fetchAgent(input.agentId);
  } catch (error) {
    const message = toErrorMessage(error);
    return isAgentNotFoundErrorMessage(message)
      ? { kind: "not_found" }
      : { kind: "error", message };
  }

  if (!result) {
    return { kind: "not_found" };
  }

  // `storeAgent` returns the record it just wrote, so there is no need to
  // re-read the store and guess which of `agents`/`agentDetails` it landed in.
  return { kind: "resolved", agent: input.storeAgent(result) };
}
