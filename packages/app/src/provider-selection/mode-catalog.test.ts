import type { AgentMode } from "@getpaseo/protocol/agent-types";
import { describe, expect, it } from "vitest";
import { mergeAgentModes } from "./mode-catalog";

function mode(id: string, label = id): AgentMode {
  return { id, label };
}

describe("mergeAgentModes", () => {
  it("appends the modes the workspace does not report", () => {
    expect(mergeAgentModes([mode("build"), mode("plan")], [mode("build"), mode("scale")])).toEqual([
      mode("build"),
      mode("plan"),
      mode("scale"),
    ]);
  });

  it("keeps the workspace order and the workspace copy of a shared id", () => {
    const merged = mergeAgentModes(
      [mode("scale", "Scale from workspace"), mode("build")],
      [mode("build", "Build from host"), mode("plan")],
    );
    expect(merged.map((entry) => entry.id)).toEqual(["scale", "build", "plan"]);
    expect(merged[1].label).toBe("build");
  });

  it("returns the workspace array itself when the host adds nothing", () => {
    const workspace = [mode("build"), mode("plan")];
    expect(mergeAgentModes(workspace, [mode("plan")])).toBe(workspace);
    expect(mergeAgentModes(workspace, [])).toBe(workspace);
    expect(mergeAgentModes(workspace, undefined)).toBe(workspace);
  });
});
