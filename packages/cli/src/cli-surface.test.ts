import { describe, expect, it } from "vitest";
import { createCli } from "./cli.js";

describe("canonical CLI surface", () => {
  it("shows workspace and heartbeat commands while hiding worktree compatibility", () => {
    const cli = createCli();
    const help = cli.helpInformation();
    expect(help).toContain("workspace");
    expect(help).toContain("heartbeat");
    expect(help).not.toContain("worktree");
  });

  it("hides legacy run worktree syntax", () => {
    const run = createCli().commands.find((command) => command.name() === "run");
    expect(run?.helpInformation()).toContain("--isolation <local|worktree>");
    expect(run?.helpInformation()).not.toContain("--worktree <name>");
  });

  it("uses background for execution and reserves detach for ownership", () => {
    const run = createCli().commands.find((command) => command.name() === "run");
    expect(run?.helpInformation()).toContain("--background");
    expect(run?.helpInformation()).not.toContain("--detach");
  });
});
