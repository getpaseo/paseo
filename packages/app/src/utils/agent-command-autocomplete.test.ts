import { describe, expect, it } from "vitest";

import { DEFAULT_COMPOSER_SIGILS } from "@/composer/tokens/sigils";
import {
  applySlashCommandReplacement,
  filterAndRankCommandAutocompleteEntries,
  filterInlineSkillCommandEntries,
  findActiveSlashCommand,
  shouldSubmitShellVariable,
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
  const sigils = DEFAULT_COMPOSER_SIGILS;

  it("detects a slash command token in the middle of the prompt", () => {
    const text = "use /tas before implementation";

    expect(
      findActiveSlashCommand({
        text,
        cursorIndex: "use /tas".length,
        sigils,
      }),
    ).toEqual({
      start: 4,
      end: "use /tas".length,
      query: "tas",
      position: "inline",
      menu: "command",
      sigil: "/",
    });
  });

  it("classifies a slash command token at the prompt start", () => {
    expect(
      findActiveSlashCommand({
        text: "/rew",
        cursorIndex: "/rew".length,
        sigils,
      }),
    ).toEqual({
      start: 0,
      end: "/rew".length,
      query: "rew",
      position: "start",
      menu: "command",
      sigil: "/",
    });
  });

  it("returns null when the cursor is outside the slash token", () => {
    expect(
      findActiveSlashCommand({
        text: "use /taste now",
        cursorIndex: "use /taste now".length,
        sigils,
      }),
    ).toBeNull();
  });

  it("returns null for slash-delimited paths", () => {
    expect(
      findActiveSlashCommand({
        text: "read /tmp/project",
        cursorIndex: "read /tmp/project".length,
        sigils,
      }),
    ).toBeNull();
  });

  it("opens the skills-only menu for the skill sigil anywhere in the prompt", () => {
    const text = "please run $rel";

    expect(
      findActiveSlashCommand({
        text,
        cursorIndex: text.length,
        sigils,
      }),
    ).toEqual({
      start: "please run ".length,
      end: text.length,
      query: "rel",
      position: "inline",
      menu: "skill",
      sigil: "$",
    });
  });

  it("lets the sigil nearest the cursor win", () => {
    const text = "/review then $rel";

    expect(findActiveSlashCommand({ text, cursorIndex: text.length, sigils })?.menu).toBe("skill");
  });

  it("honours remapped sigils", () => {
    const remapped = { command: "!", skill: "#" } as const;
    const text = "!dep";

    expect(findActiveSlashCommand({ text, cursorIndex: text.length, sigils: remapped })).toEqual({
      start: 0,
      end: text.length,
      query: "dep",
      position: "start",
      menu: "command",
      sigil: "!",
    });
    // `/` is ordinary prose once it is not a configured sigil.
    expect(findActiveSlashCommand({ text: "/dep", cursorIndex: 4, sigils: remapped })).toBeNull();
    // It still delimits paths, so remapping `/` must not make path-like queries valid.
    const pathLike = "#tmp/project";
    expect(
      findActiveSlashCommand({
        text: pathLike,
        cursorIndex: pathLike.length,
        sigils: remapped,
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
        command: {
          start: 4,
          end: "use /tas".length,
          query: "tas",
          position: "inline",
          menu: "command",
          sigil: "/",
        },
        commandName: "taste",
      }),
    ).toBe("use /taste before implementation");
  });

  it("commits an inline slash token at the prompt tail", () => {
    const text = "use /tas";

    expect(
      applySlashCommandReplacement({
        text,
        command: {
          start: 4,
          end: text.length,
          query: "tas",
          position: "inline",
          menu: "command",
          sigil: "/",
        },
        commandName: "taste",
      }),
    ).toBe("use /taste ");
  });

  it("commits a start slash token at the prompt tail", () => {
    const text = "/tas";

    expect(
      applySlashCommandReplacement({
        text,
        command: {
          start: 0,
          end: text.length,
          query: "tas",
          position: "start",
          menu: "command",
          sigil: "/",
        },
        commandName: "taste",
      }),
    ).toBe("/taste ");
  });

  it("commits a configured trigger as canonical slash syntax", () => {
    const text = "run $rel";

    expect(
      applySlashCommandReplacement({
        text,
        command: {
          start: 4,
          end: text.length,
          query: "rel",
          position: "inline",
          menu: "skill",
          sigil: "$",
        },
        commandName: "release-beta",
      }),
    ).toBe("run /release-beta ");
  });
});

describe("shouldSubmitShellVariable", () => {
  const shellVariable = {
    start: 6,
    end: 11,
    query: "HOME",
    position: "inline",
    menu: "skill",
    sigil: "$",
  } as const;

  it("reserves Enter for shell-variable-shaped dollar triggers", () => {
    expect(shouldSubmitShellVariable({ key: "Enter", command: shellVariable })).toBe(true);
    expect(
      shouldSubmitShellVariable({
        key: "Enter",
        command: { ...shellVariable, query: "XDG_CONFIG_HOME" },
      }),
    ).toBe(true);
    expect(
      shouldSubmitShellVariable({
        key: "Enter",
        command: { ...shellVariable, query: "path" },
      }),
    ).toBe(true);
  });

  it("protects shell variables when the dollar sigil is the command trigger", () => {
    expect(
      shouldSubmitShellVariable({
        key: "Enter",
        command: { ...shellVariable, menu: "command" },
      }),
    ).toBe(true);
    expect(
      shouldSubmitShellVariable({
        key: "Tab",
        command: { ...shellVariable, menu: "command" },
      }),
    ).toBe(false);
  });

  it("allows explicit selection and ordinary configured triggers", () => {
    expect(shouldSubmitShellVariable({ key: "Tab", command: shellVariable })).toBe(false);
    expect(
      shouldSubmitShellVariable({
        key: "Enter",
        command: { ...shellVariable, query: "release-beta" },
      }),
    ).toBe(false);
    expect(
      shouldSubmitShellVariable({
        key: "Enter",
        command: { ...shellVariable, sigil: "!" },
      }),
    ).toBe(false);
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
