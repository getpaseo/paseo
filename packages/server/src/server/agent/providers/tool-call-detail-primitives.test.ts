import { describe, expect, it } from "vitest";
import { ToolShellInputSchema, toShellToolDetail } from "./tool-call-detail-primitives.js";

describe("toShellToolDetail", () => {
  it("keeps the agent's own description of the command", () => {
    const input = ToolShellInputSchema.parse({
      command: "gh auth status",
      description: "Check GitHub login",
    });
    expect(toShellToolDetail(input, null)).toEqual({
      type: "shell",
      command: "gh auth status",
      description: "Check GitHub login",
    });
  });

  it("leaves the description out when the provider sends none", () => {
    expect(toShellToolDetail(ToolShellInputSchema.parse({ cmd: "ls" }), null)).toEqual({
      type: "shell",
      command: "ls",
    });
  });
});
