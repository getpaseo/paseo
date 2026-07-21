import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";
import { buildCommandAutocompleteOptions } from "./use-agent-autocomplete";

const t = ((key: string) => key) as TFunction;

describe("buildCommandAutocompleteOptions", () => {
  it("keeps the best agent at the visible bottom/default position above the input", () => {
    const options = buildCommandAutocompleteOptions({
      isVisible: true,
      mode: "file",
      commands: [],
      isDraftContext: false,
      commandFilterQuery: "",
      activeSlashCommand: null,
      activeFileMention: { start: 0, end: 1, query: "" },
      agentSuggestions: [
        {
          serverId: "server-1",
          agentId: "best-agent",
          title: "Review",
          provider: "codex",
          workspaceLabel: "Payments",
        },
        {
          serverId: "server-1",
          agentId: "second-agent",
          title: "Review",
          provider: "claude",
          workspaceLabel: "Accounts",
        },
      ],
      fileSuggestions: [
        { kind: "file", path: "best-file.ts" },
        { kind: "file", path: "second-file.ts" },
      ],
      t,
    });

    expect(options.map((option) => option.id)).toEqual([
      "file:second-file.ts",
      "file:best-file.ts",
      "agent:server-1:second-agent",
      "agent:server-1:best-agent",
    ]);
    expect(options.at(-1)).toMatchObject({
      kind: "agent",
      description: "Payments · codex",
    });
  });
});
