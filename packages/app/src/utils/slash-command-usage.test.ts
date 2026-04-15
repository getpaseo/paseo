import { describe, expect, it } from "vitest";
import { orderAutocompleteOptions } from "@/components/ui/autocomplete-utils";
import type { AgentSlashCommand } from "@/hooks/use-agent-commands-query";
import { parseSlashCommandName, rankSlashCommandsByUsage } from "./slash-command-usage";

const COMMANDS: AgentSlashCommand[] = [
  { name: "gsd-debug", description: "", argumentHint: "" },
  { name: "gsd-plan-phase", description: "", argumentHint: "" },
  { name: "gsd-review", description: "", argumentHint: "" },
];

describe("parseSlashCommandName", () => {
  it("returns the first slash command token", () => {
    expect(parseSlashCommandName("  /gsd-plan-phase add auth  ")).toBe("gsd-plan-phase");
  });

  it("returns null for plain prompts and invalid slash inputs", () => {
    expect(parseSlashCommandName("build the thing")).toBeNull();
    expect(parseSlashCommandName("/")).toBeNull();
    expect(parseSlashCommandName("/foo/bar")).toBeNull();
  });
});

describe("rankSlashCommandsByUsage", () => {
  it("sorts higher-usage commands first before above-input reversal", () => {
    const ranked = rankSlashCommandsByUsage(COMMANDS, {
      "gsd-plan-phase": 7,
      "gsd-debug": 2,
      "gsd-review": 1,
    });

    expect(ranked.map((command) => command.name)).toEqual([
      "gsd-plan-phase",
      "gsd-debug",
      "gsd-review",
    ]);

    const rendered = orderAutocompleteOptions(ranked);
    expect(rendered.at(-1)?.name).toBe("gsd-plan-phase");
  });

  it("falls back to alphabetical order when usage matches", () => {
    const ranked = rankSlashCommandsByUsage(COMMANDS, {});

    expect(ranked.map((command) => command.name)).toEqual([
      "gsd-debug",
      "gsd-plan-phase",
      "gsd-review",
    ]);
  });
});
