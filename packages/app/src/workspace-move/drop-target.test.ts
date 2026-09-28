import { describe, expect, it } from "vitest";
import { decodeWorkspaceDropTarget, dragEndPoint, encodeWorkspaceDropTarget } from "./drop-target";

describe("workspace drop targets", () => {
  it("round-trips a workspace and rejects malformed values", () => {
    const encoded = encodeWorkspaceDropTarget({ serverId: "srv_1", workspaceId: "wks_2" });
    expect(decodeWorkspaceDropTarget(encoded)).toEqual({ serverId: "srv_1", workspaceId: "wks_2" });
    expect(decodeWorkspaceDropTarget("nope")).toBeNull();
    expect(decodeWorkspaceDropTarget("|wks")).toBeNull();
  });

  it("finds where the pointer ended from where the drag started", () => {
    const start = { clientX: 10, clientY: 20 } as unknown as Event;
    expect(dragEndPoint(start, { x: 5, y: 300 })).toEqual({ x: 15, y: 320 });
    expect(dragEndPoint(null, { x: 5, y: 5 })).toBeNull();
  });
});
