import { describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_PROFILES,
  getTerminalProfileIcon,
  guessTerminalProfileIcon,
  resolveTerminalProfiles,
} from "./terminal-profiles.js";

describe("resolveTerminalProfiles", () => {
  it("returns defaults when undefined", () => {
    const result = resolveTerminalProfiles(undefined);
    expect(result).toBe(DEFAULT_TERMINAL_PROFILES);
  });

  it("returns an empty array as-is when defined as empty", () => {
    const result = resolveTerminalProfiles([]);
    expect(result).toEqual([]);
  });

  it("returns a custom array as-is", () => {
    const custom = [{ id: "zsh", name: "Zsh", command: "zsh" }];
    const result = resolveTerminalProfiles(custom);
    expect(result).toBe(custom);
  });

  it("default profiles include claude, codex, opencode", () => {
    const ids = DEFAULT_TERMINAL_PROFILES.map((p) => p.id);
    expect(ids).toContain("claude");
    expect(ids).toContain("codex");
    expect(ids).toContain("opencode");
  });

  it("claude profile has the correct icon", () => {
    const claude = DEFAULT_TERMINAL_PROFILES.find((p) => p.id === "claude");
    expect(claude?.icon).toBe("claude");
  });

  it("codex profile has the correct icon", () => {
    const codex = DEFAULT_TERMINAL_PROFILES.find((p) => p.id === "codex");
    expect(codex?.icon).toBe("codex");
  });

  it("opencode profile has the correct icon", () => {
    const opencode = DEFAULT_TERMINAL_PROFILES.find((p) => p.id === "opencode");
    expect(opencode?.icon).toBe("opencode");
  });
});

describe("guessTerminalProfileIcon", () => {
  it.each([
    ["claude", "claude"],
    ["codex", "codex"],
    ["opencode", "opencode"],
    ["copilot", "copilot"],
    ["kiro", "kiro"],
    ["omp", "omp"],
    ["pi", "pi"],
    ["gemini", "gemini"],
    ["cursor", "cursor"],
    ["goose", "goose"],
    ["grok", "grok"],
    ["kimi", "kimi"],
    ["Claude", "claude"],
    ["CODEX", "codex"],
    ["/usr/local/bin/claude", "claude"],
    ["C:\\\\Program Files\\\\Codex\\\\codex.exe", "codex"],
    ["/usr/local/bin/gemini", "gemini"],
    ["agy", "agy"],
    ["/usr/local/bin/agy", "agy"],
  ])("guesses %s -> %s", (command, expected) => {
    expect(guessTerminalProfileIcon(command)).toBe(expected);
  });

  it.each([["zsh"], ["bash"], ["fish"], [""], ["/usr/bin/foo"], ["cursor-agent"]])(
    "returns undefined for unknown command %s",
    (command) => {
      expect(guessTerminalProfileIcon(command)).toBeUndefined();
    },
  );
});

describe("getTerminalProfileIcon", () => {
  it("returns the explicit icon when set", () => {
    const profile = { id: "1", name: "Foo", command: "zsh", icon: "claude" };
    expect(getTerminalProfileIcon(profile)).toBe("claude");
  });

  it("guesses the icon when none is set", () => {
    const profile = { id: "1", name: "Foo", command: "claude" };
    expect(getTerminalProfileIcon(profile)).toBe("claude");
  });

  it("returns undefined when no icon is set and command is unknown", () => {
    const profile = { id: "1", name: "Foo", command: "zsh" };
    expect(getTerminalProfileIcon(profile)).toBeUndefined();
  });
});
