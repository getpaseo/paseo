import { describe, expect, it } from "vitest";

import { shouldHideCommandAutocomplete } from "./use-agent-autocomplete";

function shouldHide(
  overrides: Partial<Parameters<typeof shouldHideCommandAutocomplete>[0]> = {},
): boolean {
  return shouldHideCommandAutocomplete({
    mode: "command",
    isCommandsLoading: true,
    isConnected: true,
    isInlineSlashCommand: false,
    ...overrides,
  });
}

describe("shouldHideCommandAutocomplete", () => {
  it("keeps root slash commands visible while provider commands load", () => {
    expect(shouldHide()).toBe(false);
  });

  it("keeps root slash commands visible before the host connects", () => {
    expect(shouldHide({ isConnected: false })).toBe(false);
  });

  it("keeps inline commands visible with a loading state while connected", () => {
    expect(shouldHide({ isInlineSlashCommand: true })).toBe(false);
  });

  it("hides inline commands while disconnected so they do not wait forever", () => {
    expect(shouldHide({ isConnected: false, isInlineSlashCommand: true })).toBe(true);
  });

  it("shows inline commands once they are cached while disconnected", () => {
    expect(
      shouldHide({ isCommandsLoading: false, isConnected: false, isInlineSlashCommand: true }),
    ).toBe(false);
  });

  it("does not hide file autocomplete while commands load", () => {
    expect(shouldHide({ mode: "file", isInlineSlashCommand: true })).toBe(false);
  });
});
