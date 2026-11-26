import { describe, expect, it } from "vitest";
import { CLIENT_CAPS } from "./client-capabilities.js";
import {
  AgentProviderSwitchRequestSchema,
  AgentProviderSwitchResponseMessageSchema,
  AgentTimelineItemPayloadSchema,
  FetchAgentTimelineResponseMessageSchema,
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  WSHelloMessageSchema,
} from "./messages.js";
import { isTimelineTurnTrigger } from "./timeline-turn.js";

describe("provider switching protocol", () => {
  it("parses agent.provider.switch.request and response including agent snapshot on rejection", () => {
    const request = SessionInboundMessageSchema.parse({
      type: "agent.provider.switch.request",
      requestId: "req-switch-1",
      agentId: "agent-1",
      provider: "codex",
      model: "gpt-5.4",
      modeId: "auto",
      thinkingOptionId: "high",
      providerOptions: { fast_mode: true },
      text: "Continue in Codex",
      messageId: "msg-switch-1",
      attachments: [
        {
          type: "text",
          mimeType: "text/plain",
          text: "extra context",
        },
      ],
    });
    expect(request).toEqual(AgentProviderSwitchRequestSchema.parse(request));

    const acceptedResponse = SessionOutboundMessageSchema.parse({
      type: "agent.provider.switch.response",
      payload: {
        requestId: "req-switch-1",
        agentId: "agent-1",
        accepted: true,
        error: null,
      },
    });
    expect(acceptedResponse).toEqual(
      AgentProviderSwitchResponseMessageSchema.parse(acceptedResponse),
    );

    const postCommitError = AgentProviderSwitchResponseMessageSchema.parse({
      type: "agent.provider.switch.response",
      payload: {
        requestId: "req-switch-1",
        agentId: "agent-1",
        accepted: false,
        agent: {
          id: "agent-1",
          provider: "codex",
          cwd: "/repo",
          model: "gpt-5.4",
          createdAt: "2026-11-25T10:00:00.000Z",
          updatedAt: "2026-11-25T10:01:00.000Z",
          lastUserMessageAt: null,
          status: "error",
          capabilities: {
            supportsStreaming: true,
            supportsSessionPersistence: true,
            supportsDynamicModes: true,
            supportsMcpServers: true,
            supportsReasoningStream: true,
            supportsToolInvocations: true,
          },
          currentModeId: "auto",
          availableModes: [],
          pendingPermissions: [],
          persistence: null,
          title: "Chat",
          labels: {},
        },
        error: "Rate limit exceeded",
      },
    });
    expect(postCommitError.payload.accepted).toBe(false);
    expect(postCommitError.payload.agent?.provider).toBe("codex");
  });

  it("parses provider_switch timeline items including null toSessionId and marks them turn triggers", () => {
    const item = AgentTimelineItemPayloadSchema.parse({
      type: "provider_switch",
      fromProvider: "claude",
      toProvider: "codex",
      fromModel: "claude-sonnet-4-6",
      toModel: "gpt-5.4",
      fromSessionId: "claude-sess-1",
      toSessionId: null,
      context: {
        includedItems: 12,
        truncated: true,
        omittedOlderItems: true,
        truncatedText: false,
        charCount: 14_200,
        budgetChars: 100_000,
      },
    });
    expect(item.type).toBe("provider_switch");
    expect(isTimelineTurnTrigger(item)).toBe(true);
  });

  it("supports optional activeSegmentStartSeq on fetch_agent_timeline_response", () => {
    const base = {
      type: "fetch_agent_timeline_response" as const,
      payload: {
        requestId: "req-1",
        agentId: "agent-1",
        agent: null,
        direction: "tail" as const,
        projection: "projected" as const,
        epoch: "ep-1",
        reset: false,
        staleCursor: false,
        gap: false,
        window: { minSeq: 1, maxSeq: 12, nextSeq: 13 },
        startCursor: { epoch: "ep-1", seq: 1 },
        endCursor: { epoch: "ep-1", seq: 12 },
        hasOlder: false,
        hasNewer: false,
        entries: [],
        error: null,
      },
    };
    const withoutBoundary = FetchAgentTimelineResponseMessageSchema.parse(base);
    expect(withoutBoundary.payload.activeSegmentStartSeq).toBeUndefined();

    const withBoundary = FetchAgentTimelineResponseMessageSchema.parse({
      ...base,
      payload: { ...base.payload, activeSegmentStartSeq: 9 },
    });
    expect(withBoundary.payload.activeSegmentStartSeq).toBe(9);
  });

  it("supports features.providerSwitching and CLIENT_CAPS.timelineProviderSwitches", () => {
    const info = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "srv-1",
      features: { providerSwitching: true },
    });
    expect(info.features?.providerSwitching).toBe(true);

    const legacyInfo = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "srv-1",
      features: {},
    });
    expect(legacyInfo.features?.providerSwitching).toBeUndefined();

    const hello = WSHelloMessageSchema.parse({
      type: "hello",
      clientId: "client-1",
      clientType: "browser",
      protocolVersion: 1,
      capabilities: {
        [CLIENT_CAPS.timelineProviderSwitches]: true,
      },
    });
    expect(hello.capabilities?.[CLIENT_CAPS.timelineProviderSwitches]).toBe(true);
  });
});
