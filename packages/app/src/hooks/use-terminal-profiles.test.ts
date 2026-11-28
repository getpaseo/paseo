import { describe, expect, it } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { TerminalProfile } from "@getpaseo/protocol/messages";
import { DEFAULT_TERMINAL_PROFILES } from "@getpaseo/protocol/terminal-profiles";
import { resolveLaunchableTerminalProfiles } from "./use-terminal-profiles";

function entry(provider: string, status: ProviderSnapshotEntry["status"]): ProviderSnapshotEntry {
  return { provider, status, enabled: true };
}

const onlyClaudeInstalled: ProviderSnapshotEntry[] = [
  entry("claude", "ready"),
  entry("codex", "unavailable"),
  entry("opencode", "unavailable"),
  entry("pi", "unavailable"),
];

describe("resolveLaunchableTerminalProfiles", () => {
  it("hides the default profiles whose provider the host reports as not installed", () => {
    const profiles = resolveLaunchableTerminalProfiles(undefined, onlyClaudeInstalled);

    expect(profiles.map((profile) => profile.id)).toEqual(["claude"]);
  });

  it("offers every default profile while the host has not reported its providers", () => {
    const profiles = resolveLaunchableTerminalProfiles(undefined, undefined);

    expect(profiles).toEqual(DEFAULT_TERMINAL_PROFILES);
  });

  it("keeps a profile the user saved even when its provider is not installed", () => {
    const saved: TerminalProfile[] = [
      { id: "profile_1", name: "Codex", command: "codex", icon: "codex" },
    ];

    const profiles = resolveLaunchableTerminalProfiles(saved, onlyClaudeInstalled);

    expect(profiles.map((profile) => profile.id)).toEqual(["profile_1"]);
  });
});
