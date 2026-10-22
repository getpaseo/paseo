import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import type { AgentSlashCommand } from "./use-agent-commands-query";
import {
  buildCommandAutocompleteOptions,
  resolveCompactCommandVisibility,
} from "./use-agent-autocomplete";

const commands: AgentSlashCommand[] = [
  { name: "claude-md-improver", description: "Improve CLAUDE.md", argumentHint: "" },
  { name: "codex/review", description: "Review with Codex", argumentHint: "" },
  { name: "dev", description: "Start dev", argumentHint: "" },
  { name: "devtools", description: "Open devtools", argumentHint: "" },
];

const t = ((key: string) => key) as unknown as TFunction;

function buildOptions(compactCommandSuggestions: boolean) {
  return buildCommandAutocompleteOptions({
    isVisible: true,
    mode: "command",
    commands,
    pluginCommands: [],
    isDraftContext: true,
    commandFilterQuery: "dev",
    activeSlashCommand: { start: 0, end: 4, query: "dev", position: "start" },
    activeFileMention: null,
    fileSuggestions: [],
    compactCommandSuggestions,
    t,
  });
}

describe("buildCommandAutocompleteOptions", () => {
  it("keeps only the two best matches when compact", () => {
    expect(buildOptions(true).map((option) => option.label)).toEqual(["/devtools", "/dev"]);
  });

  it("keeps every match when not compact", () => {
    const labels = buildOptions(false).map((option) => option.label);
    expect(labels).toHaveLength(4);
    expect(labels[labels.length - 1]).toBe("/dev");
  });
});

describe("resolveCompactCommandVisibility", () => {
  it("hides the picker for a bare slash in compact mode", () => {
    expect(
      resolveCompactCommandVisibility({
        compactCommandSuggestions: true,
        mode: "command",
        commandFilterQuery: "",
      }),
    ).toBe(false);
  });

  it("shows the picker once a query is typed in compact mode", () => {
    expect(
      resolveCompactCommandVisibility({
        compactCommandSuggestions: true,
        mode: "command",
        commandFilterQuery: "d",
      }),
    ).toBe(true);
  });

  it("always shows the picker when not compact", () => {
    expect(
      resolveCompactCommandVisibility({
        compactCommandSuggestions: false,
        mode: "command",
        commandFilterQuery: "",
      }),
    ).toBe(true);
  });
});
