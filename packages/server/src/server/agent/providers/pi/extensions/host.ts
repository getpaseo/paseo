import type { Logger } from "pino";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentStreamEvent,
} from "../../../agent-sdk-types.js";
import type { PiAgentMessage } from "../rpc-types.js";
import { mapPiChildSession, PiChildSessionFollower } from "./child-session.js";
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

interface Session {
  id: string;
  adapter: PiExtensionSession;
}

export class PiExtensionHost {
  private readonly sessions: Session[] = [];
  private remainingHydrationBytes: number;
  private readonly followers = new Map<
    string,
    { reader: PiChildSessionFollower; pending: Promise<void> }
  >();
  private onFollowEvent?: (event: AgentStreamEvent) => void;
  private followTimer?: ReturnType<typeof setInterval>;
  private pollingExtensions = false;

  constructor(
    extensions: readonly PiExtension[],
    private readonly logger?: Pick<Logger, "warn">,
    hydrationByteBudget = Number.POSITIVE_INFINITY,
    private readonly readChildSession: typeof mapPiChildSession = mapPiChildSession,
  ) {
    this.remainingHydrationBytes = hydrationByteBudget;
    for (const extension of extensions) {
      const adapter = this.safe(extension.id, "createSession", () => extension.createSession());
      if (adapter) this.sessions.push({ id: extension.id, adapter });
    }
  }

  follow(onEvent: (event: AgentStreamEvent) => void): void {
    this.onFollowEvent = onEvent;
    this.followTimer ??= setInterval(() => {
      for (const id of this.followers.keys()) void this.readFollower(id);
      void this.pollExtensions();
    }, 250);
  }

  close(): void {
    if (this.followTimer) clearInterval(this.followTimer);
    this.followTimer = undefined;
    this.onFollowEvent = undefined;
    this.followers.clear();
  }

  private readFollower(id: string): Promise<void> {
    const follower = this.followers.get(id);
    if (!follower) return Promise.resolve();
    follower.pending = follower.pending
      .then(async () => {
        const events = await follower.reader.readNew();
        for (const event of events) {
          this.onFollowEvent?.({ type: "provider_subagent", provider: "pi", event });
        }
        return undefined;
      })
      .catch((error) => {
        this.logger?.warn(
          { err: error, operation: "follow", childId: id },
          "Pi child follow failed",
        );
      });
    return follower.pending;
  }

  private async pollExtensions(): Promise<void> {
    if (this.pollingExtensions || !this.onFollowEvent) return;
    this.pollingExtensions = true;
    try {
      for (const { id, adapter } of this.sessions) {
        const mapping = this.safe(id, "poll", () => adapter.poll?.());
        if (!mapping) continue;
        const output = this.prepare(id, mapping);
        for (const event of output.events) this.onFollowEvent?.(event);
        for (const event of await output.hydration) this.onFollowEvent?.(event);
      }
    } finally {
      this.pollingExtensions = false;
    }
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

  mapRuntimeNotification(message: string): PiExtensionOutput<PiExtensionCustomMapping> | undefined {
    for (const { id, adapter } of this.sessions) {
      const mapping = this.safe(id, "mapRuntimeNotification", () =>
        adapter.mapRuntimeNotification?.(message),
      );
      if (mapping) return this.prepare(id, mapping);
    }
    return undefined;
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
    const statusByChild = new Map(
      (mapping.subagents ?? []).flatMap((event) =>
        event.type === "upsert" && event.status ? [[event.id, event.status] as const] : [],
      ),
    );
    const hydration = Promise.all([
      ...(mapping.childSessions ?? []).map(async ({ id: childId, file }) => {
        if (this.onFollowEvent && statusByChild.get(childId) === "running") {
          if (!this.followers.has(childId)) {
            this.followers.set(childId, {
              reader: new PiChildSessionFollower(childId, file),
              pending: Promise.resolve(),
            });
          }
          await this.readFollower(childId);
          return [];
        }
        if (this.followers.has(childId)) {
          await this.readFollower(childId);
          this.followers.delete(childId);
          return [];
        }
        const bytes = Math.min(this.remainingHydrationBytes, 2 * 1024 * 1024);
        if (bytes <= 0) return [];
        this.remainingHydrationBytes -= bytes;
        return (await this.readChildSession(childId, file, bytes)).map(
          (event): AgentStreamEvent => ({ type: "provider_subagent", provider: "pi", event }),
        );
      }),
      ...[...statusByChild].flatMap(([childId, status]) =>
        status !== "running" && this.followers.has(childId)
          ? [
              this.readFollower(childId).then(() => {
                this.followers.delete(childId);
                return [];
              }),
            ]
          : [],
      ),
    ])
      .then((groups) => groups.flat())
      .catch((error): AgentStreamEvent[] => {
        this.logger?.warn(
          { err: error, extensionId: id, operation: "hydrate" },
          "Pi extension adapter failed",
        );
        return [];
      });
    return { ...mapping, events, hydration };
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
