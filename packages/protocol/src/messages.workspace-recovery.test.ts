import { describe, expect, test } from "vitest";
import {
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  ServerInfoStatusPayloadSchema,
} from "./messages.js";

describe("workspace recovery protocol", () => {
  test("parses the read-only recovery inspection exchange", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "workspace.recovery.inspect.request",
        requestId: "inspect-1",
        workspaceId: "wks_15a1b5630ebaab33",
      }),
    ).toMatchObject({ type: "workspace.recovery.inspect.request" });

    expect(
      SessionOutboundMessageSchema.parse({
        type: "workspace.recovery.inspect.response",
        payload: {
          requestId: "inspect-1",
          state: {
            kind: "recoverable",
            workspaceId: "wks_15a1b5630ebaab33",
            workspaceName: "Codex TDD reproduction",
            action: "restore",
            branch: "diagnose-repro-tdd",
          },
        },
      }),
    ).toMatchObject({
      payload: { state: { kind: "recoverable", action: "restore" } },
    });
  });

  test("parses explicit restore success and retryable failure responses", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "workspace.recovery.restore.request",
        requestId: "restore-1",
        workspaceId: "wks_15a1b5630ebaab33",
      }),
    ).toMatchObject({ type: "workspace.recovery.restore.request" });

    for (const payload of [
      {
        requestId: "restore-1",
        workspaceId: "wks_15a1b5630ebaab33",
        accepted: true,
        error: null,
      },
      {
        requestId: "restore-2",
        workspaceId: "wks_15a1b5630ebaab33",
        accepted: false,
        error: "Project root is missing: /repo",
      },
    ]) {
      expect(
        SessionOutboundMessageSchema.parse({
          type: "workspace.recovery.restore.response",
          payload,
        }),
      ).toMatchObject({ payload });
    }
  });

  test("keeps the capability optional for older daemons", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "old-host",
        features: {},
      }).features?.workspaceRecovery,
    ).toBeUndefined();

    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "new-host",
        features: { workspaceRecovery: true },
      }).features?.workspaceRecovery,
    ).toBe(true);
  });

  test("accepts unavailable reasons added by newer daemons", () => {
    expect(
      SessionOutboundMessageSchema.parse({
        type: "workspace.recovery.inspect.response",
        payload: {
          requestId: "inspect-future",
          state: {
            kind: "unavailable",
            workspaceId: "workspace-1",
            reason: "future_recovery_constraint",
            message: "This host cannot recover the workspace yet.",
          },
        },
      }),
    ).toMatchObject({
      payload: {
        state: {
          kind: "unavailable",
          reason: "future_recovery_constraint",
        },
      },
    });
  });

  test("accepts recovery actions added by newer daemons", () => {
    expect(
      SessionOutboundMessageSchema.parse({
        type: "workspace.recovery.inspect.response",
        payload: {
          requestId: "inspect-future-action",
          state: {
            kind: "recoverable",
            workspaceId: "workspace-1",
            workspaceName: "Feature branch",
            action: "repair_from_snapshot",
            branch: "feature",
          },
        },
      }),
    ).toMatchObject({
      payload: {
        state: {
          kind: "recoverable",
          action: "repair_from_snapshot",
        },
      },
    });
  });
});
