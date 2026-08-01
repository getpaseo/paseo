import { describe, expect, test } from "vitest";

import { CLIENT_CAPS } from "./client-capabilities.js";
import {
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  WSHelloMessageSchema,
} from "./messages.js";

describe("workspace lifecycle mutation authority protocol", () => {
  test("parses acquire, renew, release, and commit requests", () => {
    const requests = [
      {
        type: "workspace.lifecycle_mutation_authority.acquire.request",
        workspaceId: "workspace-1",
        requestId: "request-acquire",
      },
      {
        type: "workspace.lifecycle_mutation_authority.renew.request",
        workspaceId: "workspace-1",
        leaseId: "lease-1",
        fence: 4,
        requestId: "request-renew",
      },
      {
        type: "workspace.lifecycle_mutation_authority.release.request",
        workspaceId: "workspace-1",
        leaseId: "lease-1",
        fence: 4,
        requestId: "request-release",
      },
      {
        type: "workspace.lifecycle_mutation_authority.commit.request",
        workspaceId: "workspace-1",
        leaseId: "lease-1",
        fence: 4,
        requestId: "request-commit",
        mutation: {
          operation: "send_agent_message",
          agentId: "agent-1",
          agentRevision: "2026-08-01T12:00:00.000Z",
          text: "Continue",
        },
      },
    ];

    expect(requests.map((request) => SessionInboundMessageSchema.parse(request).type)).toEqual(
      requests.map((request) => request.type),
    );
  });

  test("requires an exact agent revision for every agent mutation", () => {
    const operations = ["archive_agent", "send_agent_message", "refresh_agent", "cancel_agent"];

    for (const operation of operations) {
      expect(
        SessionInboundMessageSchema.safeParse({
          type: "workspace.lifecycle_mutation_authority.commit.request",
          workspaceId: "workspace-1",
          leaseId: "lease-1",
          fence: 4,
          requestId: `request-${operation}`,
          mutation: {
            operation,
            agentId: "agent-1",
            ...(operation === "send_agent_message" ? { text: "Continue" } : {}),
          },
        }).success,
      ).toBe(false);
    }
  });

  test("parses typed authority and commit responses", () => {
    expect(
      SessionOutboundMessageSchema.parse({
        type: "workspace.lifecycle_mutation_authority.acquire.response",
        payload: {
          requestId: "request-acquire",
          ok: true,
          lease: {
            workspaceId: "workspace-1",
            leaseId: "lease-1",
            fence: 4,
            expiresAt: "2026-08-01T12:00:30.000Z",
          },
        },
      }),
    ).toMatchObject({ payload: { ok: true, lease: { fence: 4 } } });

    expect(
      SessionOutboundMessageSchema.parse({
        type: "workspace.lifecycle_mutation_authority.commit.response",
        payload: {
          requestId: "request-commit",
          ok: false,
          error: {
            code: "agent_revision_mismatch",
            message: "Agent revision changed before commit",
          },
        },
      }),
    ).toMatchObject({
      payload: { ok: false, error: { code: "agent_revision_mismatch" } },
    });
  });

  test("keeps feature and client capability negotiation optional", () => {
    expect(
      WSHelloMessageSchema.parse({
        type: "hello",
        clientId: "new-client",
        clientType: "cli",
        protocolVersion: 1,
        capabilities: { [CLIENT_CAPS.workspaceLifecycleMutationAuthority]: true },
      }).capabilities,
    ).toMatchObject({ [CLIENT_CAPS.workspaceLifecycleMutationAuthority]: true });
    expect(
      WSHelloMessageSchema.parse({
        type: "hello",
        clientId: "old-client",
        clientType: "cli",
        protocolVersion: 1,
      }).capabilities,
    ).toBeUndefined();

    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "server-1",
        features: { workspaceLifecycleMutationAuthority: true },
      }).features?.workspaceLifecycleMutationAuthority,
    ).toBe(true);
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "server-1",
      }).features,
    ).toBeUndefined();
  });
});
