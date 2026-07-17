import { describe, expect, test } from "vitest";

import { mapOmpAvailableCommandsUpdate, mapOmpSlashCommands } from "./commands.js";

describe("OMP slash command mapper", () => {
  test("maps command updates and preserves input hints", () => {
    const commands = mapOmpAvailableCommandsUpdate({
      type: "available_commands_update",
      commands: [
        { name: "todo", description: "Manage todos", input: { hint: "<subcommand>" } },
        { name: "fast", description: "Toggle fast mode", input: { hint: "[on|off|status]" } },
        { name: "handoff", description: "Start a handoff" },
      ],
    });

    expect(commands?.find((command) => command.name === "todo")).toEqual({
      name: "todo",
      description: "Manage todos",
      argumentHint: "<subcommand>",
      kind: "command",
    });
    expect(commands?.find((command) => command.name === "fast")).toEqual({
      name: "fast",
      description: "Toggle fast mode",
      argumentHint: "[on|off|status]",
      kind: "command",
    });
    expect(commands?.find((command) => command.name === "handoff")).toEqual({
      name: "handoff",
      description: "Start a handoff",
      argumentHint: "[instructions]",
      kind: "command",
    });
  });

  test("maps source-attributed OMP 17 commands", () => {
    const commands = mapOmpAvailableCommandsUpdate({
      type: "available_commands_update",
      commands: [
        {
          name: "prewalk",
          description: "Prewalk at the next action",
          source: "builtin",
        },
      ],
    });

    expect(commands?.find((command) => command.name === "prewalk")).toEqual({
      name: "prewalk",
      description: "Prewalk at the next action",
      argumentHint: "",
      kind: "command",
    });
  });

  test("drops malformed command updates", () => {
    expect(
      mapOmpAvailableCommandsUpdate({ type: "available_commands_update", commands: [{}] }),
    ).toBeNull();
  });

  test("adds OMP-only out-of-band commands to handled built-ins", () => {
    expect(mapOmpSlashCommands([]).map((command) => command.name)).toEqual([
      "compact",
      "autocompact",
      "handoff",
      "steer",
      "follow-up",
    ]);
  });
});
