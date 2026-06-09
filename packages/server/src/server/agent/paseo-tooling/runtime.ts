import { randomBytes } from "node:crypto";

import type {
  AgentProvider,
  PaseoToolingLaunchContext,
  PaseoToolingProviderSessionRef,
} from "../agent-sdk-types.js";

interface PaseoToolingRuntimeEndpoints {
  mcpBaseUrl: string | null;
  httpBaseUrl: string | null;
}

export class PaseoToolingRuntime {
  private mcpBaseUrl: string | null = null;
  private httpBaseUrl: string | null = null;
  private enabled = true;
  private readonly sessionBindings = new Map<string, string>();
  readonly token = randomBytes(32).toString("hex");

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  setEndpoints(endpoints: PaseoToolingRuntimeEndpoints): void {
    this.mcpBaseUrl = endpoints.mcpBaseUrl;
    this.httpBaseUrl = endpoints.httpBaseUrl;
  }

  createLaunchContext(agentId: string): PaseoToolingLaunchContext | undefined {
    if (!this.enabled || (!this.mcpBaseUrl && !this.httpBaseUrl)) {
      return undefined;
    }

    return {
      agentId,
      mcpUrl: this.mcpBaseUrl ? `${this.mcpBaseUrl}?callerAgentId=${agentId}` : null,
      httpBaseUrl: this.httpBaseUrl,
      token: this.token,
      bindProviderSession: (ref) => this.bindProviderSession({ ...ref, agentId }),
    };
  }

  bindProviderSession(ref: PaseoToolingProviderSessionRef & { agentId: string }): () => void {
    const key = providerSessionKey(ref.provider, ref.sessionId);
    this.sessionBindings.set(key, ref.agentId);
    return () => {
      if (this.sessionBindings.get(key) === ref.agentId) {
        this.sessionBindings.delete(key);
      }
    };
  }

  resolveProviderSession(ref: PaseoToolingProviderSessionRef): string | null {
    return this.sessionBindings.get(providerSessionKey(ref.provider, ref.sessionId)) ?? null;
  }
}

function providerSessionKey(provider: AgentProvider, sessionId: string): string {
  return `${provider}:${sessionId}`;
}
