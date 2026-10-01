import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createCli } from "./cli.js";

describe("canonical CLI surface", () => {
  it("offers team tracking and messages with JSON and host selection", () => {
    const team = createCli().commands.find((command) => command.name() === "team");
    expect(team?.commands.map((command) => command.name())).toEqual([
      "ls",
      "inspect",
      "events",
      "message",
    ]);
    for (const command of team!.commands) {
      expect(command.helpInformation()).toContain("--json");
      expect(command.helpInformation()).toContain("--host <host>");
    }
  });

  it("accepts zero as a team event cursor", () => {
    const team = createCli().commands.find((command) => command.name() === "team")!;
    const events = team.commands.find((command) => command.name() === "events")!;
    events.parseOptions(["--after", "0"]);
    expect(events.opts().after).toBe(0);
  });

  it.each(["-1", "1.5", "1e3", "9007199254740992"])(
    "rejects invalid team event cursor %s",
    (cursor) => {
      const team = createCli().commands.find((command) => command.name() === "team")!;
      const events = team.commands.find((command) => command.name() === "events")!;
      events.exitOverride().configureOutput({ writeErr: () => {} });
      expect(() => events.parseOptions(["--after", cursor])).toThrow(
        "Commit must be a non-negative safe integer",
      );
    },
  );

  it("uses PandaOS as the displayed CLI name", () => {
    const cli = createCli();
    expect(cli.name()).toBe("pandaos");
    expect(cli.description()).toContain("PandaOS");
  });

  it("installs pandaos as the only CLI command", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.bin).toEqual({ pandaos: "bin/pandaos" });
  });

  it("offers daemon host selection as a global option", () => {
    expect(createCli().helpInformation()).toContain("--host <host>");
  });

  it("shows project, workspace, and heartbeat commands while hiding worktree compatibility", () => {
    const cli = createCli();
    const help = cli.helpInformation();
    expect(help).toContain("project");
    expect(help).toContain("workspace");
    expect(help).toContain("heartbeat");
    expect(help).not.toContain("worktree");
  });

  it("offers identical top-level and daemon config reload commands", () => {
    const cli = createCli();
    const reload = cli.commands.find((command) => command.name() === "reload");
    const daemon = cli.commands.find((command) => command.name() === "daemon");
    const nestedReload = daemon?.commands.find((command) => command.name() === "reload");

    expect(reload?.helpInformation()).toContain("--host <host>");
    expect(reload?.helpInformation()).toContain("--json");
    expect(nestedReload?.helpInformation()).toContain("--host <host>");
    expect(nestedReload?.helpInformation()).toContain("--json");
  });

  it("names explicit workspace creation without exposing older syntax", () => {
    const run = createCli().commands.find((command) => command.name() === "run");
    const help = run?.helpInformation();
    expect(help).toContain("--new-workspace <local|worktree>");
    expect(help).not.toContain("--isolation");
    expect(help).not.toContain("--worktree <name>");
  });

  it("offers the worktree creation options on run", () => {
    const run = createCli().commands.find((command) => command.name() === "run");
    const help = run?.helpInformation();
    expect(help).toContain("--worktree-mode <mode>");
    expect(help).toContain("--worktree-slug <slug>");
    expect(help).toContain("--new-branch <name>");
    expect(help).toContain("--branch <name>");
    expect(help).toContain("--pr-number <n>");
    expect(help).toContain("--forge <forge>");
  });

  it("uses background for execution and reserves detach for ownership", () => {
    const run = createCli().commands.find((command) => command.name() === "run");
    expect(run?.helpInformation()).toContain("--background");
    expect(run?.helpInformation()).not.toContain("--detach");
  });

  it("offers thinking configuration when running, updating, and scheduling agents", () => {
    const cli = createCli();
    const run = cli.commands.find((command) => command.name() === "run");
    const agent = cli.commands.find((command) => command.name() === "agent");
    const update = agent?.commands.find((command) => command.name() === "update");
    const schedule = cli.commands.find((command) => command.name() === "schedule");
    const scheduleCreate = schedule?.commands.find((command) => command.name() === "create");

    expect(run?.helpInformation()).toContain("--thinking <id>");
    expect(update?.helpInformation()).toContain("--thinking <id>");
    expect(scheduleCreate?.helpInformation()).toContain("--thinking <id>");
  });

  it("offers opening an existing agent in the desktop app", () => {
    const agent = createCli().commands.find((command) => command.name() === "agent");
    const open = agent?.commands.find((command) => command.name() === "open");

    expect(open?.helpInformation()).toContain("<agent-id>");
    expect(open?.helpInformation()).toContain("--server <server-id>");
  });

  it("offers listing and running verify recipes against a workspace", () => {
    const verify = createCli().commands.find((command) => command.name() === "verify");
    const ls = verify?.commands.find((command) => command.name() === "ls");
    const run = verify?.commands.find((command) => command.name() === "run");

    expect(ls?.helpInformation()).toContain("--workspace <workspace-id>");
    expect(run?.helpInformation()).toContain("<name>");
    expect(run?.helpInformation()).toContain("--param <name=value>");
    expect(run?.helpInformation()).toContain("--json");
  });

  it("offers the complete local plugin lifecycle", () => {
    const plugin = createCli().commands.find((command) => command.name() === "plugin");

    expect(plugin?.commands.map((command) => command.name())).toEqual([
      "init",
      "ls",
      "status",
      "logs",
      "install",
      "update",
      "reload",
      "enable",
      "disable",
      "remove",
    ]);
    expect(
      plugin?.commands.find((command) => command.name() === "init")?.helpInformation(),
    ).toContain("--id <id>");
    expect(
      plugin?.commands.find((command) => command.name() === "install")?.helpInformation(),
    ).toContain("--id <id>");
  });
});
