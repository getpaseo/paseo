import { describe, expect, it } from "vitest";
import { resolveAutocompleteIsVisible } from "./use-agent-autocomplete";

describe("resolveAutocompleteIsVisible", () => {
  const commandBase = {
    mode: "command" as const,
    canLoadCommands: true,
    serverId: "server-1",
    autocompleteCwd: "/repo",
    isCommandsLoading: false,
    isDraftContext: false,
  };

  it("stays open while a draft composer spins up its provider session", () => {
    expect(
      resolveAutocompleteIsVisible({
        ...commandBase,
        isCommandsLoading: true,
        isDraftContext: true,
      }),
    ).toBe(true);
  });

  it("hides the in-session flash while commands load", () => {
    expect(
      resolveAutocompleteIsVisible({
        ...commandBase,
        isCommandsLoading: true,
      }),
    ).toBe(false);
  });

  it("opens once commands resolve in either context", () => {
    expect(resolveAutocompleteIsVisible(commandBase)).toBe(true);
    expect(resolveAutocompleteIsVisible({ ...commandBase, isDraftContext: true })).toBe(true);
  });

  it("stays closed when commands cannot be loaded at all", () => {
    expect(
      resolveAutocompleteIsVisible({
        ...commandBase,
        canLoadCommands: false,
        isDraftContext: true,
      }),
    ).toBe(false);
  });

  it("keeps file mentions gated on a resolved workspace directory", () => {
    expect(
      resolveAutocompleteIsVisible({ ...commandBase, mode: "file", autocompleteCwd: "" }),
    ).toBe(false);
    expect(
      resolveAutocompleteIsVisible({ ...commandBase, mode: "file", isCommandsLoading: true }),
    ).toBe(true);
  });
});
