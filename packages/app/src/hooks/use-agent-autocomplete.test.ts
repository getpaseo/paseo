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
      description: expect.stringContaining("Paseo local"),
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

  it("orders exact, prefix, then substring command matches predictably", () => {
    const options = __private__.buildCommandAutocompleteOptions({
      query: "test",
      commands: [
        { name: "contest", description: "Substring" },
        { name: "test", description: "Exact" },
        { name: "test-run", description: "Prefix" },
      ],
    });

    expect(options.map((option) => option.label)).toEqual(["/test", "/test-run", "/contest"]);
  });

  it("places the best command at the fallback-selected above-input position", () => {
    const options = __private__.buildPresentedCommandAutocompleteOptions({
      query: "q",
      commands: [
        {
          name: "quick-review",
          description: "Provider command",
        },
      ],
    });

    expect(options.at(-1)).toMatchObject({
      type: "local_command",
      id: "q",
      label: "/q",
    });
  });

  it("shows command argument hints in descriptions", () => {
    const options = __private__.buildCommandAutocompleteOptions({
      query: "review",
      commands: [
        {
          name: "review",
          description: "Review a change",
          argumentHint: "<target>",
        },
      ],
    });

    expect(options[0]).toMatchObject({
      label: "/review",
      description: "Review a change - <target>",
    });
  });
});
