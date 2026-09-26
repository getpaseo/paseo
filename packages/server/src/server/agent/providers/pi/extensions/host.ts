import type { Logger } from "pino";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentStreamEvent,
} from "../../../agent-sdk-types.js";
import type { PiAgentMessage } from "../rpc-types.js";
import { mapPiChildSession } from "./child-session.js";
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
    const hydration = Promise.all(
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
