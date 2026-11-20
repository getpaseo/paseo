import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import { render } from "../../output/index.js";
import { permitResponseSchema, toPermissionResponseItem } from "./allow.js";
import { listPendingPermissions } from "./ls.js";

const agentId = "2d85f428-fdaf-4d98-906f-c583de2b805f";

function permissionRequest(id: string): AgentPermissionRequest {
  return { id, provider: "claude", name: "Write", kind: "tool" };
}

const writeRequest = permissionRequest("permission-cc93510e-a45d-4c4e-a0bf-fc2821f82783");
const editRequest = permissionRequest("permission-654ff862-b312-4f6e-8aac-427421ff65eb");

const agent = {
  id: agentId,
  pendingPermissions: [writeRequest, editRequest],
} as AgentSnapshotPayload;

describe("permit ls output", () => {
  it("emits full request ids that permit allow accepts", () => {
    const result = listPendingPermissions([agent]);

    const listed = JSON.parse(render(result, { format: "json" })) as Array<{ id: string }>;
    expect(listed.map((item) => item.id)).toEqual([writeRequest.id, editRequest.id]);
    expect(render(result, { quiet: true }).split("\n")).toEqual([writeRequest.id, editRequest.id]);
  });
});

describe("permit allow and deny output", () => {
  it("emits the full id of the request that was answered", () => {
    const result = {
      type: "list" as const,
      data: [toPermissionResponseItem(agentId, writeRequest, "allowed")],
      schema: permitResponseSchema,
    };

    const answered = JSON.parse(render(result, { format: "json" })) as Array<{
      requestId: string;
    }>;
    expect(answered.map((item) => item.requestId)).toEqual([writeRequest.id]);
  });
});
