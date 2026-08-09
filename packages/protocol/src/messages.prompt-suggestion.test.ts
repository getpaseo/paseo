import { describe, expect, test } from "vitest";

import { CLIENT_CAPS } from "./client-capabilities.js";
import {
  AgentStreamEventPayloadSchema,
  ServerInfoStatusPayloadSchema,
  WSHelloMessageSchema,
} from "./messages.js";

describe("prompt suggestion wire contract", () => {
  test("round-trips the exact suggestion and completed turn identity", () => {
    const payload = {
      type: "prompt_suggestion",
      provider: "claude",
      turnId: "foreground-turn-7",
      suggestion: "Run the focused tests, then ship it.",
      messageId: "suggestion-message-1",
    } as const;

    expect(AgentStreamEventPayloadSchema.parse(payload)).toEqual(payload);
  });

  test("accepts an opt-in client capability without changing legacy hello", () => {
    const legacy = WSHelloMessageSchema.parse({
      type: "hello",
      clientId: "legacy-client",
      clientType: "mcp",
      protocolVersion: 1,
    });
    const capable = WSHelloMessageSchema.parse({
      type: "hello",
      clientId: "capable-client",
      clientType: "mcp",
      protocolVersion: 1,
      capabilities: { [CLIENT_CAPS.promptSuggestions]: true },
    });

    expect(legacy.capabilities).toBeUndefined();
    expect(capable.capabilities).toEqual({ prompt_suggestions: true });
  });

  test("preserves the server support feature", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "server-1",
      features: { promptSuggestions: true },
    });

    expect(parsed.features?.promptSuggestions).toBe(true);
  });
});
