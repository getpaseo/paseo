import { describe, expect, it } from "vitest";

import {
  filterCommandAutocompleteOptions,
  getCommandAutocompleteFallbackIndex,
  getCommandAutocompleteScrollOffset,
  orderCommandAutocompleteOptions,
  type AgentSlashCommand,
} from "./command-autocomplete-utils";

const COMMANDS: AgentSlashCommand[] = [
  { name: "alpha", description: "Alpha command", argumentHint: "<path>" },
  { name: "beta", description: "Beta command", argumentHint: "" },
  { name: "gamma", description: "Gamma command", argumentHint: "<value>" },
];

describe("command autocomplete helpers", () => {
  it("filters command names case-insensitively", () => {
    expect(filterCommandAutocompleteOptions(COMMANDS, "AL")).toEqual([
      { name: "alpha", description: "Alpha command", argumentHint: "<path>" },
    ]);
  });

  it("orders commands so the first logical result is closest to the input", () => {
    expect(orderCommandAutocompleteOptions(COMMANDS).map((cmd) => cmd.name)).toEqual([
      "gamma",
      "beta",
      "alpha",
    ]);
  });

  it("uses the command nearest the input as fallback selection", () => {
    expect(getCommandAutocompleteFallbackIndex(3)).toBe(2);
    expect(getCommandAutocompleteFallbackIndex(0)).toBe(-1);
  });

  it("scrolls up when the active item is above the viewport", () => {
    expect(
      getCommandAutocompleteScrollOffset({
        currentOffset: 120,
        viewportHeight: 80,
        itemTop: 90,
        itemHeight: 20,
      })
    ).toBe(90);
  });

  it("scrolls down when the active item is below the viewport", () => {
    expect(
      getCommandAutocompleteScrollOffset({
        currentOffset: 0,
        viewportHeight: 100,
        itemTop: 150,
        itemHeight: 24,
      })
    ).toBe(74);
  });
});
