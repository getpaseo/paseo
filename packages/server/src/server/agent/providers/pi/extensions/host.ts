import type { Logger } from "pino";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentStreamEvent,
} from "../../../agent-sdk-types.js";
import type { PiAgentMessage } from "../rpc-types.js";
import { mapPiChildSession } from "./child-session.js";
import { PiChildSessionFollower, type PiChildSessionScheduler } from "./child-session-follower.js";
import type {
  PiExtension,
  PiExtensionCustomMapping,
  PiExtensionDialog,
  PiExtensionDialogMapping,
  PiExtensionSession,
  PiExtensionToolCall,
  PiExtensionToolMapping,
  PiExtensionUiReply,
} from "./contract.js";

export type PiExtensionOutput<T> = T & {
  events: AgentStreamEvent[];
  hydration: Promise<AgentStreamEvent[]>;
};
export type PiExtensionEventOutput = PiExtensionOutput<
  PiExtensionToolMapping | PiExtensionCustomMapping
>;

/**
 * Live child-session following.
 *
 * Omitted on the replay path, where a child file is complete by definition and reading it once is
 * both correct and cheaper.
 */
export interface PiExtensionFollowOptions {
  onEvents(events: AgentStreamEvent[]): void;
  scheduler?: PiChildSessionScheduler;
  intervalMs?: number;
  maxFollowedFiles?: number;
  maxBytesPerRead?: number;
  maxBytesPerChild?: number;
}

interface Session {
  id: string;
  adapter: PiExtensionSession;
}

export class PiExtensionHost {
  private readonly sessions: Session[] = [];
  private readonly follower: PiChildSessionFollower | null;
  private remainingHydrationBytes: number;

  constructor(
    extensions: readonly PiExtension[],
    private readonly logger?: Pick<Logger, "warn">,
    hydrationByteBudget = Number.POSITIVE_INFINITY,
    private readonly readChildSession: typeof mapPiChildSession = mapPiChildSession,
    follow?: PiExtensionFollowOptions,
  ) {
    this.remainingHydrationBytes = hydrationByteBudget;
    for (const extension of extensions) {
      const adapter = this.safe(extension.id, "createSession", () => extension.createSession());
      if (adapter) this.sessions.push({ id: extension.id, adapter });
    }
    this.follower = follow
      ? new PiChildSessionFollower({
          ...follow,
          onTick: () => this.pollChildren(follow.onEvents),
          hasPoll: (extensionId) =>
            this.sessions.some(
              (session) => session.id === extensionId && session.adapter.poll !== undefined,
            ),
          onWarn: (message, details) => this.logger?.warn(details, message),
        })
      : null;
  }

  private safe<T>(id: string, operation: string, call: () => T): T | undefined {
    try {
      return call();
    } catch (error) {
      this.logger?.warn({ err: error, extensionId: id, operation }, "Pi extension adapter failed");
      return undefined;
    }
  }

  mapToolCall(call: PiExtensionToolCall): PiExtensionOutput<PiExtensionToolMapping> | undefined {
    for (const { id, adapter } of this.sessions) {
      const mapping = this.safe(id, "mapToolCall", () => adapter.mapToolCall?.(call));
      if (mapping) {
        const prepared = this.safe(id, "prepare", () => this.prepare(id, mapping));
        if (prepared) return prepared;
      }
    }
    return undefined;
  }

  mapCustomMessage(
    message: Extract<PiAgentMessage, { role: "custom" }>,
  ): PiExtensionOutput<PiExtensionCustomMapping> | undefined {
    for (const { id, adapter } of this.sessions) {
      const mapping = this.safe(id, "mapCustomMessage", () => adapter.mapCustomMessage?.(message));
      if (mapping) {
        const prepared = this.safe(id, "prepare", () => this.prepare(id, mapping));
        if (prepared) return prepared;
      }
    }
    return undefined;
  }

  /** Stops following child sessions and cancels any scheduled read. */
  close(): void {
    this.follower?.close();
  }

  private prepare<T extends PiExtensionToolMapping | PiExtensionCustomMapping>(
    id: string,
    mapping: T,
  ): PiExtensionOutput<T> {
    const events: AgentStreamEvent[] = [
      ...("timeline" in mapping ? (mapping.timeline ?? []) : []).map(
        (item): AgentStreamEvent => ({ type: "timeline", provider: "pi", item }),
      ),
      ...(mapping.subagents ?? []).map(
        (event): AgentStreamEvent => ({ type: "provider_subagent", provider: "pi", event }),
      ),
    ];
    if (this.follower) {
      // The follower owns the reads and emits through `onEvents`, so nothing is hydrated here.
      this.follower.accept(id, mapping);
      return { ...mapping, events, hydration: Promise.resolve([]) };
    }
    return { ...mapping, events, hydration: this.hydrateChildSessions(id, mapping) };
  }

  private hydrateChildSessions<T extends PiExtensionToolMapping | PiExtensionCustomMapping>(
    id: string,
    mapping: T,
  ): Promise<AgentStreamEvent[]> {
    return Promise.all(
      (mapping.childSessions ?? []).map(async ({ id: childId, file }) => {
        const bytes = Math.min(this.remainingHydrationBytes, 2 * 1024 * 1024);
        if (bytes <= 0) return [];
        this.remainingHydrationBytes -= bytes;
        return (await this.readChildSession(childId, file, bytes)).map(
          (event): AgentStreamEvent => ({ type: "provider_subagent", provider: "pi", event }),
        );
      }),
    )
      .then((groups) => groups.flat())
      .catch((error): AgentStreamEvent[] => {
        this.logger?.warn(
          { err: error, extensionId: id, operation: "hydrate" },
          "Pi extension adapter failed",
        );
        return [];
      });
  }

  /**
   * Asks every adapter that publishes live child state to refresh, and emits what it produced.
   *
   * The follower drives this because only it knows that a child is still running and worth asking
   * about.
   */
  private pollChildren(emit: (events: AgentStreamEvent[]) => void): void {
    for (const { id, adapter } of this.sessions) {
      if (!adapter.poll) continue;
      const mapping = this.safe(id, "poll", () => adapter.poll?.());
      if (!mapping) continue;
      const prepared = this.safe(id, "prepare", () => this.prepare(id, mapping));
      if (prepared?.events.length) emit(prepared.events);
    }
  }

  onToolStart(call: PiExtensionToolCall, provider = "pi"): AgentPermissionRequest | undefined {
    let request: AgentPermissionRequest | undefined;
    for (const { id, adapter } of this.sessions) {
      const candidate = this.safe(id, "onToolStart", () => adapter.onToolStart?.(call, provider));
      request ??= candidate;
    }
    return request;
  }

  onToolEnd(call: PiExtensionToolCall): void {
    for (const { id, adapter } of this.sessions) {
      this.safe(id, "onToolEnd", () => adapter.onToolEnd?.(call));
    }
  }

  mapDialog(dialog: PiExtensionDialog, provider: string): PiExtensionDialogMapping | undefined {
    for (const { id, adapter } of this.sessions) {
      const mapping = this.safe(id, "mapDialog", () => adapter.mapDialog?.(dialog, provider));
      if (mapping) return mapping;
    }
    return undefined;
  }

  respondToPermission(
    request: AgentPermissionRequest,
    response: AgentPermissionResponse,
  ): PiExtensionUiReply | undefined {
    for (const { id, adapter } of this.sessions) {
      const mapped = this.safe(id, "respondToPermission", () =>
        adapter.respondToPermission?.(request, response),
      );
      if (mapped) return mapped;
    }
    return undefined;
  }
}
