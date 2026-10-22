import { describe, expect, it } from "vitest";

import {
  applySlashCommandReplacement,
  filterAndRankCommandAutocompleteEntries,
  filterInlineSkillCommandEntries,
  findActiveSlashCommand,
} from "./agent-command-autocomplete";

describe("filterAndRankCommandAutocompleteEntries", () => {
  const entries = [
    { source: "provider" as const, command: { name: "paseo-committee" } },
    { source: "provider" as const, command: { name: "commit" } },
    { source: "provider" as const, command: { name: "paseo-advisor" } },
  ];

  it("ranks command-name prefixes above later word-boundary partial matches", () => {
    const result = filterAndRankCommandAutocompleteEntries(entries, "comm");

    expect(result.map((entry) => entry.command.name)).toEqual(["commit", "paseo-committee"]);
  });

  it("matches client command aliases", () => {
    const result = filterAndRankCommandAutocompleteEntries(
      [
        { source: "client" as const, command: { name: "exit", aliases: ["quit", "q"] } },
        { source: "client" as const, command: { name: "clear", aliases: ["new"] } },
      ],
      "q",
    );

    expect(result.map((entry) => entry.command.name)).toEqual(["exit"]);
  });
});

describe("findActiveSlashCommand", () => {
  it("detects a slash command token in the middle of the prompt", () => {
    const text = "use /tas before implementation";

    expect(
      findActiveSlashCommand({
        text,
        cursorIndex: "use /tas".length,
      }),
    ).toEqual({
      start: 4,
      end: "use /tas".length,
      query: "tas",
      position: "inline",
    });
  });

  it("classifies a slash command token at the prompt start", () => {
    expect(
      findActiveSlashCommand({
        text: "/rew",
        cursorIndex: "/rew".length,
      }),
    ).toEqual({
      start: 0,
      end: "/rew".length,
      query: "rew",
      position: "start",
    });
  });

  it("returns null when the cursor is outside the slash token", () => {
    expect(
      findActiveSlashCommand({
        text: "use /taste now",
        cursorIndex: "use /taste now".length,
      }),
    ).toBeNull();
  });

  it("returns null for slash-delimited paths", () => {
    expect(
      findActiveSlashCommand({
        text: "read /tmp/project",
        cursorIndex: "read /tmp/project".length,
      }),
    ).toBeNull();
  });
});

describe("applySlashCommandReplacement", () => {
  it("replaces only the active slash token", () => {
    const text = "use /tas before implementation";

    expect(
      applySlashCommandReplacement({
        text,
        command: { start: 4, end: "use /tas".length, query: "tas", position: "inline" },
        commandName: "taste",
      }),
    ).toBe("use /taste before implementation");
  });

  it("commits an inline slash token at the prompt tail", () => {
    const text = "use /tas";

    expect(
      applySlashCommandReplacement({
        text,
        command: { start: 4, end: text.length, query: "tas", position: "inline" },
        commandName: "taste",
      }),
    ).toBe("use /taste ");
  });

  it("commits a start slash token at the prompt tail", () => {
    const text = "/tas";

    expect(
      applySlashCommandReplacement({
        text,
        command: { start: 0, end: text.length, query: "tas", position: "start" },
        commandName: "taste",
      }),
    ).toBe("/taste ");
  });
});

describe("filterInlineSkillCommandEntries", () => {
  it("keeps provider skills and drops executable commands", () => {
    const entries = [
      { source: "client" as const, command: { name: "clear", kind: "command" } },
      { source: "provider" as const, command: { name: "compact", kind: "command" } },
      { source: "provider" as const, command: { name: "taste", kind: "skill" } },
    ];

    expect(filterInlineSkillCommandEntries(entries).map((entry) => entry.command.name)).toEqual([
      "taste",
    ]);
  });
});
