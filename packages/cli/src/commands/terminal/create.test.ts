import { describe, expect, it } from "vitest";
import { buildLaunchCommand } from "./create.js";

describe("terminal create launch command", () => {
  it("returns undefined when no command is given", () => {
    expect(buildLaunchCommand(undefined)).toBeUndefined();
    expect(buildLaunchCommand([])).toBeUndefined();
  });

  it("splits the command from its arguments", () => {
    expect(buildLaunchCommand(["hydra", "tui", "--new"])).toEqual({
      command: "hydra",
      args: ["tui", "--new"],
    });
  });

  it("handles a bare command with no arguments", () => {
    expect(buildLaunchCommand(["htop"])).toEqual({ command: "htop", args: [] });
  });
});
