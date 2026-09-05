import { describe, expect, test } from "vitest";
import {
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  WorkspaceDescriptorPayloadSchema,
  WorkspacePinGroupSchema,
} from "./messages.js";

describe("workspace pin group wire schemas", () => {
  test("keeps old pin requests targeting the implicit default group", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "workspace.pin.set.request",
        workspaceId: "ws-1",
        pinned: true,
        requestId: "req-pin",
      }),
    ).toEqual({
      type: "workspace.pin.set.request",
      workspaceId: "ws-1",
      pinned: true,
      requestId: "req-pin",
    });
  });

  test("round-trips group membership on its paired RPC", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "workspace.pin_group.set_membership.request",
        workspaceId: "ws-1",
        groupId: "pgrp_focus",
        requestId: "req-pin",
      }),
    ).toMatchObject({ groupId: "pgrp_focus" });
    expect(
      SessionOutboundMessageSchema.parse({
        type: "workspace.pin_group.set_membership.response",
        payload: {
          requestId: "req-pin",
          workspaceId: "ws-1",
          groupId: "pgrp_focus",
        },
      }),
    ).toMatchObject({ payload: { groupId: "pgrp_focus" } });
  });

  test("parses the paired group CRUD RPCs", () => {
    const group = WorkspacePinGroupSchema.parse({
      id: "pgrp_focus",
      name: "Focus",
      createdAt: "2026-08-31T12:00:00.000Z",
    });
    const messages = [
      {
        request: { type: "workspace.pin_group.list.request", requestId: "req-list" },
        response: {
          type: "workspace.pin_group.list.response",
          payload: { requestId: "req-list", groups: [group] },
        },
      },
      {
        request: {
          type: "workspace.pin_group.set_membership.request",
          requestId: "req-membership",
          workspaceId: "ws-1",
          groupId: group.id,
        },
        response: {
          type: "workspace.pin_group.set_membership.response",
          payload: {
            requestId: "req-membership",
            workspaceId: "ws-1",
            groupId: group.id,
          },
        },
      },
      {
        request: {
          type: "workspace.pin_group.create.request",
          requestId: "req-create",
          name: "Focus",
        },
        response: {
          type: "workspace.pin_group.create.response",
          payload: { requestId: "req-create", group },
        },
      },
      {
        request: {
          type: "workspace.pin_group.rename.request",
          requestId: "req-rename",
          groupId: group.id,
          name: "This week",
        },
        response: {
          type: "workspace.pin_group.rename.response",
          payload: { requestId: "req-rename", group: { ...group, name: "This week" } },
        },
      },
      {
        request: {
          type: "workspace.pin_group.delete.request",
          requestId: "req-delete",
          groupId: group.id,
        },
        response: {
          type: "workspace.pin_group.delete.response",
          payload: { requestId: "req-delete", groupId: group.id },
        },
      },
    ] as const;

    for (const message of messages) {
      expect(SessionInboundMessageSchema.parse(message.request)).toEqual(message.request);
      expect(SessionOutboundMessageSchema.parse(message.response)).toEqual(message.response);
    }
  });

  test("keeps the feature and descriptor membership optional for older peers", () => {
    const oldServer = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "old-host",
      features: {},
    });
    expect(oldServer.features?.workspacePinGroups).toBeUndefined();

    const descriptor = {
      id: "ws-1",
      projectId: "proj-1",
      projectDisplayName: "repo",
      projectRootPath: "/repo",
      workspaceDirectory: "/repo",
      projectKind: "git",
      workspaceKind: "local_checkout",
      name: "main",
      status: "done",
      activityAt: null,
      scripts: [],
    };
    expect(WorkspaceDescriptorPayloadSchema.parse(descriptor).pinGroupId).toBeUndefined();
    expect(WorkspaceDescriptorPayloadSchema.parse(descriptor).pinGroupAssignedAt).toBeUndefined();
    expect(
      WorkspaceDescriptorPayloadSchema.parse({
        ...descriptor,
        pinGroupId: "pgrp_focus",
        pinGroupAssignedAt: "2026-08-31T12:00:00.000Z",
      }),
    ).toMatchObject({
      pinGroupId: "pgrp_focus",
      pinGroupAssignedAt: "2026-08-31T12:00:00.000Z",
    });
  });

  test("carries optional catalog invalidation on the existing workspace update channel", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "workspace_update",
      payload: {
        kind: "remove",
        id: "ws-1",
        pinGroups: [
          {
            id: "default",
            name: "Pinned",
            createdAt: "2026-08-31T12:00:00.000Z",
          },
        ],
      },
    });
    expect(parsed).toMatchObject({
      type: "workspace_update",
      payload: { pinGroups: [{ id: "default" }] },
    });
  });
});
