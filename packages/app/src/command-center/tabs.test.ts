import { describe, expect, it } from "vitest";
import { rotateCommandCenterTab, type CommandCenterTab } from "./tabs";

describe("rotateCommandCenterTab", () => {
  it("walks All, Workspaces, Files, Actions and wraps", () => {
    const walked: CommandCenterTab[] = ["all"];
    for (let step = 0; step < 4; step += 1) {
      walked.push(rotateCommandCenterTab(walked[walked.length - 1], "next"));
    }
    expect(walked).toEqual(["all", "workspaces", "files", "actions", "all"]);
  });

  it("walks backwards and wraps from All to Actions", () => {
    expect(rotateCommandCenterTab("all", "previous")).toBe("actions");
    expect(rotateCommandCenterTab("files", "previous")).toBe("workspaces");
  });
});
