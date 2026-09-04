import { describe, expect, test } from "vitest";
import type { AgentCapabilityFlags, AgentSession } from "../agent-sdk-types.js";
import {
  invokeNativeForkCapability,
  NativeForkCapabilityError,
  resolveNativeForkMessageId,
} from "./native-fork.js";

function buildSession(input: {
  capabilities?: Partial<AgentCapabilityFlags>;
  forkNativeSession?: AgentSession["forkNativeSession"];
}): AgentSession {
  return {
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: true,
      ...input.capabilities,
    },
    ...(input.forkNativeSession ? { forkNativeSession: input.forkNativeSession } : {}),
  } as AgentSession;
}

describe("invokeNativeForkCapability", () => {
  test("returns the provider's new session handle", async () => {
    const calls: { messageId?: string }[] = [];
    const session = buildSession({
      capabilities: { supportsNativeFork: true },
      forkNativeSession: async (args) => {
        calls.push(args);
        return { providerHandleId: "thread-2" };
      },
    });

    const result = await invokeNativeForkCapability(session, { messageId: "message-1" });

    expect(result).toEqual({ providerHandleId: "thread-2" });
    expect(calls).toEqual([{ messageId: "message-1" }]);
  });

  test("rejects a provider that does not declare the capability", async () => {
    const session = buildSession({
      capabilities: { supportsNativeFork: false },
      forkNativeSession: async () => ({ providerHandleId: "thread-2" }),
    });

    await expect(invokeNativeForkCapability(session, { messageId: "message-1" })).rejects.toThrow(
      NativeForkCapabilityError,
    );
  });

  test("rejects a provider that declares the capability but has no implementation", async () => {
    const session = buildSession({ capabilities: { supportsNativeFork: true } });

    await expect(invokeNativeForkCapability(session, { messageId: "message-1" })).rejects.toThrow(
      NativeForkCapabilityError,
    );
  });

  // An empty handle would be imported as a session id of "", producing an agent
  // bound to nothing rather than a visible failure at the fork.
  test("rejects a blank handle instead of importing it", async () => {
    const session = buildSession({
      capabilities: { supportsNativeFork: true },
      forkNativeSession: async () => ({ providerHandleId: "   " }),
    });

    await expect(invokeNativeForkCapability(session, { messageId: "message-1" })).rejects.toThrow(
      /empty session handle/,
    );
  });
});

describe("resolveNativeForkMessageId", () => {
  test("maps a completed assistant boundary to its provider user message", () => {
    expect(
      resolveNativeForkMessageId(
        [
          {
            seq: 1,
            timestamp: "2026-08-05T00:00:00.000Z",
            turnId: "turn-1",
            providerMessageId: "provider-user-1",
            item: {
              type: "user_message",
              text: "question",
              messageId: "client-user-1",
              clientMessageId: "client-user-1",
            },
          },
          {
            seq: 2,
            timestamp: "2026-08-05T00:00:01.000Z",
            turnId: "turn-1",
            item: { type: "assistant_message", text: "answer", messageId: "assistant-1" },
          },
        ],
        "assistant-1",
      ),
    ).toBe("provider-user-1");
  });

  test("rejects an assistant boundary whose user message is not acknowledged", () => {
    expect(() =>
      resolveNativeForkMessageId(
        [
          {
            seq: 1,
            timestamp: "2026-08-05T00:00:00.000Z",
            turnId: "turn-1",
            item: {
              type: "user_message",
              text: "question",
              messageId: "client-user-1",
              clientMessageId: "client-user-1",
            },
          },
          {
            seq: 2,
            timestamp: "2026-08-05T00:00:01.000Z",
            turnId: "turn-1",
            item: { type: "assistant_message", text: "answer", messageId: "assistant-1" },
          },
        ],
        "assistant-1",
      ),
    ).toThrow("Cannot fork before the provider acknowledges the submitted prompt");
  });
});
