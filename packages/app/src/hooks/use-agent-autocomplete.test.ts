import { describe, expect, it } from "vitest";
import { __private__ } from "./use-agent-autocomplete";

describe("useAgentAutocomplete command options", () => {
  it("prioritizes Paseo-local /q over provider commands", () => {
    const options = __private__.buildCommandAutocompleteOptions({
      query: "q",
      commands: [
        {
          name: "quick-review",
          description: "Provider command",
        },
      ],
    });

    expect(options[0]).toMatchObject({
      type: "local_command",
      id: "q",
      label: "/q",
    });
    expect(options.map((option) => option.label)).toContain("/quick-review");
  });

  it("includes /exit as a Paseo-local command", () => {
    const options = __private__.buildCommandAutocompleteOptions({
      query: "exit",
      commands: [],
    });

    expect(options).toEqual([
      expect.objectContaining({
        type: "local_command",
        id: "exit",
        label: "/exit",
      }),
    ]);
  });
});
