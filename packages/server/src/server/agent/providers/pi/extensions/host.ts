import type { AgentPermissionRequest, AgentPermissionResponse } from "../../../agent-sdk-types.js";
import type {
  PiExtension,
  PiExtensionDialog,
  PiExtensionDialogMapping,
  PiExtensionToolCall,
  PiExtensionToolMapping,
  PiExtensionUiResponse,
} from "./contract.js";

export class PiExtensionHost {
  private readonly sessions;

  constructor(extensions: readonly PiExtension[]) {
    this.sessions = extensions.map((extension) => extension.createSession());
  }

  mapToolCall(call: PiExtensionToolCall): PiExtensionToolMapping | undefined {
    for (const session of this.sessions) {
      const mapping = session.mapToolCall?.(call);
      if (mapping) return mapping;
    }
    return undefined;
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
