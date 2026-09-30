import { describe, expect, test, vi } from "vitest";

import type {
  AgentCapabilityFlags,
  AgentPromptInput,
  AgentSession,
  AgentStreamEvent,
  AgentRuntimeInfo,
  SteerActiveTurnOptions,
  SteerResult,
} from "./agent-sdk-types.js";
import { wrapSessionProvider } from "./provider-registry.js";

type OptionalAgentSessionMethodName = {
  [K in keyof AgentSession]-?: undefined extends AgentSession[K]
    ? NonNullable<AgentSession[K]> extends (...args: never[]) => unknown
      ? K
      : never
    : never;
}[keyof AgentSession];

const OPTIONAL_AGENT_SESSION_METHOD_NAMES = [
  "steerActiveTurn",
  "listCommands",
  "setModel",
  "setThinkingOption",
  "setFeature",
  "revertConversation",
  "revertFiles",
  "revertBoth",
  "tryHandleOutOfBand",
] as const satisfies readonly OptionalAgentSessionMethodName[];

type MissingOptionalAgentSessionMethod = Exclude<
  OptionalAgentSessionMethodName,
  (typeof OPTIONAL_AGENT_SESSION_METHOD_NAMES)[number]
>;

const _allOptionalAgentSessionMethodsAreCovered: MissingOptionalAgentSessionMethod extends never
  ? true
  : never = true;

const CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
  supportsRewindConversation: true,
  supportsRewindFiles: true,
  supportsRewindBoth: true,
};

const RUNTIME_INFO: AgentRuntimeInfo = {
  provider: "claude",
  sessionId: "session-1",
};

class FakeSession implements AgentSession {
  readonly provider = "claude";
  readonly id = "session-1";
  readonly capabilities = CAPABILITIES;
  readonly features = [];
  readonly recordedCalls: string[] = [];

  async run() {
    this.recordedCalls.push("run");
    return { timeline: [] };
  }

  async startTurn() {
    this.recordedCalls.push("startTurn");
    return { turnId: "turn-1" };
  }

  async steerActiveTurn(
    _prompt: AgentPromptInput,
    _options: SteerActiveTurnOptions,
  ): Promise<SteerResult> {
    this.recordedCalls.push("steerActiveTurn");
    return { status: "accepted" };
  }

  subscribe(_callback: (event: AgentStreamEvent) => void) {
    this.recordedCalls.push("subscribe");
    return () => {};
  }

  async *streamHistory() {
    this.recordedCalls.push("streamHistory");
    yield* emptyHistory();
  }

  async getRuntimeInfo() {
    this.recordedCalls.push("getRuntimeInfo");
    return RUNTIME_INFO;
  }

  async getAvailableModes() {
    this.recordedCalls.push("getAvailableModes");
    return [];
  }

  async getCurrentMode() {
    this.recordedCalls.push("getCurrentMode");
    return null;
  }

  async setMode(_modeId: string) {
    this.recordedCalls.push("setMode");
  }

  getPendingPermissions() {
    this.recordedCalls.push("getPendingPermissions");
    return [];
  }

  async respondToPermission() {
    this.recordedCalls.push("respondToPermission");
  }

  describePersistence() {
    this.recordedCalls.push("describePersistence");
    return null;
  }

  async interrupt() {
    this.recordedCalls.push("interrupt");
  }

  async close() {
    this.recordedCalls.push("close");
  }

  async listCommands() {
    this.recordedCalls.push("listCommands");
    return [];
  }

  async setModel() {
    this.recordedCalls.push("setModel");
  }

  async setThinkingOption() {
    this.recordedCalls.push("setThinkingOption");
  }

  async setFeature() {
    this.recordedCalls.push("setFeature");
  }

  async revertConversation() {
    this.recordedCalls.push("revertConversation");
  }

  async revertFiles() {
    this.recordedCalls.push("revertFiles");
  }

  async revertBoth() {
    this.recordedCalls.push("revertBoth");
  }

  tryHandleOutOfBand(_prompt: AgentPromptInput) {
    this.recordedCalls.push("tryHandleOutOfBand");
    return {
      run: async () => {
        this.recordedCalls.push("tryHandleOutOfBand.run");
      },
    };
  }
}

async function* emptyHistory(): AsyncGenerator<AgentStreamEvent> {
  for (const event of [] as AgentStreamEvent[]) {
    yield event;
  }
}

describe("wrapSessionProvider", () => {
  test("forwards every optional AgentSession method", async () => {
    const session = new FakeSession();
    const wrapped = wrapSessionProvider("custom-claude", session);

    await wrapped.steerActiveTurn?.("follow-up", { expectedTurnId: "turn-1" });
    await wrapped.listCommands?.();
    await wrapped.setModel?.("sonnet");
    await wrapped.setThinkingOption?.("high");
    await wrapped.setFeature?.("feature-1", true);
    await wrapped.revertConversation?.({ messageId: "message-1" });
    await wrapped.revertFiles?.({ messageId: "message-1" });
    await wrapped.revertBoth?.({ messageId: "message-1" });
    const handler = wrapped.tryHandleOutOfBand?.("/compact");
    await handler?.run({ emit: () => {} });

    expect(session.recordedCalls).toEqual([
      "steerActiveTurn",
      "listCommands",
      "setModel",
      "setThinkingOption",
      "setFeature",
      "revertConversation",
      "revertFiles",
      "revertBoth",
      "tryHandleOutOfBand",
      "tryHandleOutOfBand.run",
    ]);
  });

  test("steers a completion notification into the inner turn with its original receiver", async () => {
    const session = new FakeSession();
    const steer = vi.spyOn(session, "steerActiveTurn");
    const wrapped = wrapSessionProvider("custom-opencode", session);
    const prompt = "<paseo-system>\nAgent child finished.\n</paseo-system>";
    const options = { expectedTurnId: "turn-1", clientMessageId: "notification-1" };

    expect(await wrapped.steerActiveTurn?.(prompt, options)).toEqual({ status: "accepted" });
    expect(steer).toHaveBeenCalledExactlyOnceWith(prompt, options);
    expect(steer.mock.contexts).toEqual([session]);
    expect(session.recordedCalls).toEqual(["steerActiveTurn"]);
  });

  test("keeps steering unavailable when the inner provider does not support it", () => {
    const session: AgentSession = new FakeSession();
    session.steerActiveTurn = undefined;

    const wrapped = wrapSessionProvider("custom-opencode", session);

    expect(wrapped.steerActiveTurn).toBeUndefined();
  });

  test("propagates a steering failure without interrupting or starting another turn", async () => {
    const session = new FakeSession();
    const error = new Error("Steer transport failed");
    const steer = vi.spyOn(session, "steerActiveTurn").mockRejectedValue(error);
    const wrapped = wrapSessionProvider("custom-opencode", session);
    const prompt = "<paseo-system>\nAgent child finished.\n</paseo-system>";
    const options = { expectedTurnId: "turn-1" };

    await expect(wrapped.steerActiveTurn?.(prompt, options)).rejects.toBe(error);
    expect(steer).toHaveBeenCalledExactlyOnceWith(prompt, options);
    expect(session.recordedCalls).toEqual([]);
  });
});
