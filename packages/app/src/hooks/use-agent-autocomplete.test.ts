import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";

import {
  buildCommandAutocompleteOptions,
  resolveCompactCommandVisibility,
} from "./use-agent-autocomplete";
import type { AgentSlashCommand } from "./use-agent-commands-query";

const COMMANDS: AgentSlashCommand[] = [
  { name: "claude-md-improver", description: "Improve the agent instructions", argumentHint: "" },
  { name: "codex/review", description: "Review the diff", argumentHint: "" },
  { name: "dev", description: "Development mode", argumentHint: "" },
  { name: "devtools", description: "Open the developer tools", argumentHint: "" },
];

const t = ((key: string) => key) as unknown as TFunction;

function buildCommandOptions(compactCommandSuggestions: boolean) {
  return buildCommandAutocompleteOptions({
    isVisible: true,
    mode: "command",
    commands: COMMANDS,
    isDraftContext: true,
    commandFilterQuery: "dev",
    activeSlashCommand: { start: 0, end: 4, query: "dev", position: "start" },
    activeFileMention: null,
    fileSuggestions: [],
    t,
    compactCommandSuggestions,
  });
}

describe("buildCommandAutocompleteOptions", () => {
  it("keeps only the two best matches when compact suggestions are on", () => {
    const options = buildCommandOptions(true);

    expect(options.map((option) => option.label)).toEqual(["/devtools", "/dev"]);
  });

  it("keeps every match when compact suggestions are off", () => {
    const options = buildCommandOptions(false);

    expect(options).toHaveLength(4);
    expect(options[options.length - 1].label).toBe("/dev");
  });
});

describe("resolveCompactCommandVisibility", () => {
  it("hides the picker for a bare slash and shows it once the user types", () => {
    expect(
      resolveCompactCommandVisibility({
        compactCommandSuggestions: true,
        mode: "command",
        commandFilterQuery: "",
      }),
    ).toBe(false);
    expect(
      resolveCompactCommandVisibility({
        compactCommandSuggestions: true,
        mode: "command",
        commandFilterQuery: "d",
      }),
    ).toBe(true);
    expect(
      resolveCompactCommandVisibility({
        compactCommandSuggestions: false,
        mode: "command",
        commandFilterQuery: "",
      }),
    ).toBe(true);
  });
});
