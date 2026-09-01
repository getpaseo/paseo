import pino from "pino";
import { describe, expect, test, vi } from "vitest";

import type { AgentManager } from "../../../agent/agent-manager.js";
import type { AgentStorage } from "../../../agent/agent-storage.js";
import type { SpeechService } from "../../../speech/speech-runtime.js";
import type { WorkspaceRegistry } from "../../../workspace-registry.js";
import type { VoiceProviderStartInput } from "../../internal/provider.js";
import { resolveManualVoiceConfig } from "./config.js";
import { createManualVoiceProvider } from "./provider.js";

function createStartInput(
  transportOffers: VoiceProviderStartInput["transportOffers"],
): VoiceProviderStartInput {
  return {
    callId: "voice-call",
    context: { workspaceId: "workspace-id", agentId: null },
    transportOffers,
    signal: new AbortController().signal,
    emit: vi.fn(),
  };
}

describe("manual voice provider speech lifecycle", () => {
  test("starts one speech runtime only when the first valid call begins", async () => {
    const startSpeech = vi.fn();
    const stopSpeech = vi.fn(async () => undefined);
    const speech = {
      start: startSpeech,
      stop: stopSpeech,
      ready: Promise.resolve(),
    } as unknown as SpeechService;
    const speechFactory = vi.fn(() => speech);
    const launchInternalAgentWithRequiredPaseoTools = vi.fn(async () => {
      throw new Error("stop after speech initialization");
    });
    const provider = createManualVoiceProvider({
      config: resolveManualVoiceConfig({
        paseoHome: "/tmp/manual-voice-provider-test",
        persisted: {
          orchestrator: { provider: "codex", modeId: "full-access" },
        },
        providers: undefined,
      }),
      agentManager: {
        getAgent: vi.fn(() => undefined),
        launchInternalAgentWithRequiredPaseoTools,
      } as unknown as AgentManager,
      agentStorage: {} as AgentStorage,
      workspaceRegistry: {
        get: vi.fn(async () => ({
          workspaceId: "workspace-id",
          cwd: "/tmp/workspace",
          archivedAt: null,
        })),
      } as unknown as Pick<WorkspaceRegistry, "get">,
      logger: pino({ level: "silent" }),
      speechFactory,
    });

    expect(provider.getReadiness()).toEqual({ ready: true });
    expect(speechFactory).not.toHaveBeenCalled();

    await expect(provider.start(createStartInput([]))).rejects.toThrow(
      "The client does not support daemon audio",
    );
    expect(speechFactory).not.toHaveBeenCalled();

    const validInput = createStartInput([{ kind: "daemon-audio" }]);
    await expect(provider.start(validInput)).rejects.toThrow("stop after speech initialization");
    await expect(provider.start(validInput)).rejects.toThrow("stop after speech initialization");

    expect(speechFactory).toHaveBeenCalledOnce();
    expect(startSpeech).toHaveBeenCalledOnce();
    expect(launchInternalAgentWithRequiredPaseoTools).toHaveBeenCalledTimes(2);

    await provider.close();
    expect(stopSpeech).toHaveBeenCalledOnce();
  });
});
