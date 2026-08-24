import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_PLACEMENT_LABEL,
  LOGICAL_WORKSPACE_REF_LABEL_PREFIX,
  RESERVED_WORKSPACE_LABEL_COLOR,
  encodeLogicalWorkspaceRefLabel,
  isReservedWorkspaceLabel,
  parseLogicalWorkspacePlacementLabels,
} from "./workspace-labels.js";

describe("reserved workspace labels", () => {
  it("publishes one closed v1 codec with a stable catalog color", () => {
    expect(LOGICAL_WORKSPACE_REF_LABEL_PREFIX).toBe("paseo:reserved:v1:logical-workspace-ref=");
    expect(DEFAULT_WORKSPACE_PLACEMENT_LABEL).toBe("paseo:reserved:v1:placement-role=default");
    expect(RESERVED_WORKSPACE_LABEL_COLOR).toBe("indigo");
    expect(encodeLogicalWorkspaceRefLabel("project-a-catalog")).toBe(
      "paseo:reserved:v1:logical-workspace-ref=project-a-catalog",
    );
  });

  it.each(["", "Cars-parts", "-project-a-catalog", "project-a/parts", "project-a parts", `a${"b".repeat(128)}`])(
    "refuses an invalid logical workspace ref: %s",
    (ref) => {
      expect(() => encodeLogicalWorkspaceRefLabel(ref)).toThrow("Invalid logical workspace ref");
    },
  );

  it("recognizes the whole reserved namespace without exposing malformed values", () => {
    expect(isReservedWorkspaceLabel("paseo:reserved:v1:logical-workspace-ref=project-a-catalog")).toBe(
      true,
    );
    expect(isReservedWorkspaceLabel(" PASEO:RESERVED:future:unknown ")).toBe(true);
    expect(isReservedWorkspaceLabel("Urgent")).toBe(false);
  });

  it("parses one valid ref and an optional default marker", () => {
    expect(
      parseLogicalWorkspacePlacementLabels([
        "Urgent",
        encodeLogicalWorkspaceRefLabel("project-a-catalog"),
        DEFAULT_WORKSPACE_PLACEMENT_LABEL,
      ]),
    ).toEqual({ logicalWorkspaceRef: "project-a-catalog", defaultPlacement: true });
    expect(
      parseLogicalWorkspacePlacementLabels([
        encodeLogicalWorkspaceRefLabel("project-a-catalog"),
        "paseo:reserved:future:unknown",
      ]),
    ).toEqual({ logicalWorkspaceRef: "project-a-catalog", defaultPlacement: false });
  });

  it("ignores malformed and unknown reserved labels deterministically", () => {
    expect(
      parseLogicalWorkspacePlacementLabels([
        "paseo:reserved:v1:logical-workspace-ref=bad/ref",
        "paseo:reserved:v2:logical-workspace-ref=project-a-catalog",
        DEFAULT_WORKSPACE_PLACEMENT_LABEL,
      ]),
    ).toBeNull();
    expect(
      parseLogicalWorkspacePlacementLabels([
        "paseo:reserved:v1:logical-workspace-ref=bad/ref",
        encodeLogicalWorkspaceRefLabel("project-a-catalog"),
        "paseo:reserved:future:unknown",
      ]),
    ).toEqual({ logicalWorkspaceRef: "project-a-catalog", defaultPlacement: false });
  });

  it("fails open to an unmanaged physical workspace when valid refs conflict", () => {
    expect(
      parseLogicalWorkspacePlacementLabels([
        encodeLogicalWorkspaceRefLabel("project-a-catalog"),
        encodeLogicalWorkspaceRefLabel("project-a-diagnostics"),
        DEFAULT_WORKSPACE_PLACEMENT_LABEL,
      ]),
    ).toBeNull();
    expect(parseLogicalWorkspacePlacementLabels([DEFAULT_WORKSPACE_PLACEMENT_LABEL])).toBeNull();
  });
});
