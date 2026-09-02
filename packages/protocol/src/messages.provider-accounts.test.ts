import { describe, expect, it } from "vitest";
import {
  AgentListItemPayloadSchema,
  AgentSnapshotPayloadSchema,
  CreateAgentRequestMessageSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

const capabilities = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

describe("provider account message fields", () => {
  it("accepts explicit managed and system account choices on agent creation", () => {
    const base = {
      type: "create_agent_request" as const,
      workspaceId: "ws-1",
      attachments: [],
      labels: {},
      requestId: "req-1",
    };

    expect(
      CreateAgentRequestMessageSchema.parse({
        ...base,
        config: {
          provider: "codex",
          cwd: "/repo",
          accountProfileId: "pac_0123456789abcdef",
        },
      }).config.accountProfileId,
    ).toBe("pac_0123456789abcdef");
    expect(
      CreateAgentRequestMessageSchema.parse({
        ...base,
        config: { provider: "codex", cwd: "/repo", accountProfileId: null },
      }).config.accountProfileId,
    ).toBeNull();
  });

  it("projects the pinned account on snapshot and list rows", () => {
    const snapshot = AgentSnapshotPayloadSchema.parse({
      id: "agent-1",
      provider: "codex",
      accountProfileId: "pac_0123456789abcdef",
      cwd: "/repo",
      model: null,
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
      lastUserMessageAt: null,
      status: "idle",
      capabilities,
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: null,
      labels: {},
    });
    const listItem = AgentListItemPayloadSchema.parse({
      id: snapshot.id,
      shortId: "agent-1",
      title: null,
      provider: snapshot.provider,
      accountProfileId: snapshot.accountProfileId,
      model: null,
      status: "idle",
      cwd: snapshot.cwd,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      lastUserMessageAt: null,
      labels: {},
    });

    expect(snapshot.accountProfileId).toBe("pac_0123456789abcdef");
    expect(listItem.accountProfileId).toBe(snapshot.accountProfileId);
  });

  it("validates provider account management requests and state responses", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "provider.account.default.set.request",
        requestId: "req-default",
        provider: "codex",
        accountProfileId: "pac_0123456789abcdef",
      }),
    ).toMatchObject({
      type: "provider.account.default.set.request",
      provider: "codex",
      accountProfileId: "pac_0123456789abcdef",
    });
    expect(
      SessionOutboundMessageSchema.parse({
        type: "provider.account.list.response",
        payload: {
          requestId: "req-list",
          accounts: [],
          defaults: { codex: null },
        },
      }),
    ).toEqual({
      type: "provider.account.list.response",
      payload: { requestId: "req-list", accounts: [], defaults: { codex: null } },
    });
  });

  it("keeps login challenges credential-free across the RPC boundary", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "provider.account.login.start.request",
        requestId: "req-login",
        accountProfileId: "pac_0123456789abcdef",
      }),
    ).toMatchObject({ type: "provider.account.login.start.request" });
    const parsed = SessionOutboundMessageSchema.parse({
      type: "provider.account.login.start.response",
      payload: {
        requestId: "req-login",
        login: {
          accountProfileId: "pac_0123456789abcdef",
          provider: "codex",
          status: "waiting",
          loginId: "login-1",
          verificationUrl: "https://auth.openai.com/device",
          userCode: "ABCD-EFGH",
          error: null,
          startedAt: "2026-08-24T00:00:00.000Z",
          updatedAt: "2026-08-24T00:00:00.000Z",
        },
        accounts: [],
        defaults: {},
      },
    });
    expect(parsed).not.toHaveProperty("payload.token");
  });
});
