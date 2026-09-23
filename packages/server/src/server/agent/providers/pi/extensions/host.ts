import type { AgentPermissionRequest, AgentPermissionResponse } from "../../../agent-sdk-types.js";
import type { AgentStreamEvent } from "../../../agent-sdk-types.js";
import { mapPiChildSession } from "./child-session.js";
import type {
  PiExtension,
  PiExtensionDialog,
  PiExtensionDialogMapping,
  PiExtensionToolCall,
  PiExtensionToolMapping,
  PiExtensionUiResponse,
} from "./contract.js";
import type { PiAgentMessage } from "../rpc-types.js";
import type { PiExtensionCustomMapping } from "./contract.js";

export type PiExtensionOutput<T> = T & {
  events: AgentStreamEvent[];
  hydration: Promise<AgentStreamEvent[]>;
};
export type PiExtensionEventOutput = PiExtensionOutput<
  PiExtensionToolMapping | PiExtensionCustomMapping
>;

export class PiExtensionHost {
  private readonly sessions;

  constructor(extensions: readonly PiExtension[]) {
    this.sessions = extensions.map((extension) => extension.createSession());
  }

  mapToolCall(call: PiExtensionToolCall): PiExtensionOutput<PiExtensionToolMapping> | undefined {
    for (const session of this.sessions) {
      const mapping = session.mapToolCall?.(call);
      if (mapping) return this.prepare(mapping);
    }
    return undefined;
  }

  mapCustomMessage(
    message: Extract<PiAgentMessage, { role: "custom" }>,
  ): PiExtensionOutput<PiExtensionCustomMapping> | undefined {
    for (const session of this.sessions) {
      const mapping = session.mapCustomMessage?.(message);
      if (mapping) return this.prepare(mapping);
    }
    return undefined;
  }

  private prepare<T extends PiExtensionToolMapping | PiExtensionCustomMapping>(
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
      (mapping.childSessions ?? []).map(async ({ id, file }) =>
        (await mapPiChildSession(id, file)).map(
          (event): AgentStreamEvent => ({ type: "provider_subagent", provider: "pi", event }),
        ),
      ),
    ).then((groups) => groups.flat());
    return { ...mapping, events, hydration };
  }

  onToolStart(call: PiExtensionToolCall): void {
    for (const session of this.sessions) session.onToolStart?.(call);
  }

  onToolEnd(call: PiExtensionToolCall): void {
    for (const session of this.sessions) session.onToolEnd?.(call);
  }

  mapDialog(dialog: PiExtensionDialog, provider: string): PiExtensionDialogMapping | undefined {
    for (const session of this.sessions) {
      const mapping = session.mapDialog?.(dialog, provider);
      if (mapping) return mapping;
    }
    return undefined;
  }

  respondToPermission(
    request: AgentPermissionRequest,
    response: AgentPermissionResponse,
  ): PiExtensionUiResponse | undefined {
    for (const session of this.sessions) {
      const mapped = session.respondToPermission?.(request, response);
      if (mapped) return mapped;
    }
    return undefined;
  }
}
