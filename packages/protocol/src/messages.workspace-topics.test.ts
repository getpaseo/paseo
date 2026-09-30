import { describe, expect, test } from "vitest";
import {
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  WorkspaceDescriptorPayloadSchema,
} from "./messages.js";

const baseDescriptor = {
  id: "wks_1",
  projectId: "prj_1",
  projectDisplayName: "repo",
  projectRootPath: "/repo",
  projectKind: "git",
  workspaceKind: "worktree",
  name: "phase-1",
  status: "done",
  activityAt: null,
  scripts: [],
} as const;

describe("workspace topic message schemas", () => {
  test("descriptors from daemons without topics parse with no topic", () => {
    expect(WorkspaceDescriptorPayloadSchema.parse(baseDescriptor).topic).toBeUndefined();
  });

  test("descriptors carry the topic they belong to", () => {
    const topic = { id: "top_1", title: "Riesling", description: null };
    expect(WorkspaceDescriptorPayloadSchema.parse({ ...baseDescriptor, topic }).topic).toEqual(
      topic,
    );
    expect(
      WorkspaceDescriptorPayloadSchema.parse({ ...baseDescriptor, topic: null }).topic,
    ).toBeNull();
  });

  test("parses the create, assign and update requests", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "workspace.topic.create.request",
        title: "Riesling",
        workspaceIds: ["wks_1", "wks_2"],
        requestId: "req-create",
      }),
    ).toEqual({
      type: "workspace.topic.create.request",
      title: "Riesling",
      workspaceIds: ["wks_1", "wks_2"],
      requestId: "req-create",
    });
    expect(
      SessionInboundMessageSchema.parse({
        type: "workspace.topic.assign.request",
        workspaceId: "wks_1",
        topicId: null,
        requestId: "req-assign",
      }),
    ).toMatchObject({ topicId: null });
    expect(
      SessionInboundMessageSchema.parse({
        type: "workspace.topic.update.request",
        topicId: "top_1",
        description: null,
        requestId: "req-update",
      }),
    ).toMatchObject({ topicId: "top_1", description: null });
  });

  test("parses the create, assign and update responses", () => {
    const topic = { id: "top_1", title: "Riesling", description: "Phase 1 and 2" };
    expect(
      SessionOutboundMessageSchema.parse({
        type: "workspace.topic.create.response",
        payload: {
          requestId: "req-create",
          accepted: true,
          topic,
          workspaceIds: ["wks_1"],
          error: null,
        },
      }),
    ).toMatchObject({ payload: { topic } });
    expect(
      SessionOutboundMessageSchema.parse({
        type: "workspace.topic.assign.response",
        payload: {
          requestId: "req-assign",
          workspaceId: "wks_1",
          accepted: false,
          topicId: null,
          error: "Topic not found",
        },
      }),
    ).toMatchObject({ payload: { accepted: false } });
    expect(
      SessionOutboundMessageSchema.parse({
        type: "workspace.topic.update.response",
        payload: { requestId: "req-update", accepted: true, topic, error: null },
      }),
    ).toMatchObject({ payload: { topic } });
  });

  test("server info without the workspaceTopics feature still parses", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "srv_1",
      features: { workspacePinning: true },
    });
    expect(parsed.features?.workspaceTopics).toBeUndefined();
  });
});
