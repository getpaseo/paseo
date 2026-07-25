import { describe, expect, it } from "vitest";
import { createWorkspaceFileAttachment } from "./workspace-file";
import {
  parseWorkspaceFileDragPayload,
  resolveWorkspaceFileDrop,
  serializeWorkspaceFileDragPayload,
  type WorkspaceFileDragPayload,
} from "./workspace-file-drag";

function payload(): WorkspaceFileDragPayload {
  return {
    version: 1,
    serverId: "server-1",
    workspaceId: "workspace-1",
    attachment: createWorkspaceFileAttachment({
      path: "src/app.ts",
      selection: { kind: "line_range", startLine: 12, endLine: 24 },
    }),
  };
}

describe("workspace file drag payload", () => {
  it("round-trips workspace identity and future line selections", () => {
    expect(parseWorkspaceFileDragPayload(serializeWorkspaceFileDragPayload(payload()))).toEqual(
      payload(),
    );
  });

  it("rejects malformed and invalid payloads", () => {
    expect(parseWorkspaceFileDragPayload("not json")).toBeNull();
    expect(
      parseWorkspaceFileDragPayload(
        JSON.stringify({
          ...payload(),
          attachment: {
            kind: "workspace_file",
            path: "src/app.ts",
            selection: { kind: "line_range", startLine: 24, endLine: 12 },
          },
        }),
      ),
    ).toBeNull();
  });

  it("accepts drops only within the originating server and workspace", () => {
    const dragged = payload();
    expect(
      resolveWorkspaceFileDrop({
        payload: dragged,
        serverId: "server-1",
        workspaceId: "workspace-1",
      }),
    ).toEqual(dragged.attachment);
    expect(
      resolveWorkspaceFileDrop({
        payload: dragged,
        serverId: "server-1",
        workspaceId: "workspace-2",
      }),
    ).toBeNull();
  });
});
