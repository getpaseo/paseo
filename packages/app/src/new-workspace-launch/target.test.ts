import { describe, expect, it } from "vitest";
import type { TerminalProfile } from "@getpaseo/protocol/messages";
import {
  BLANK_TERMINAL_PROFILE_ID,
  CHAT_LAUNCH_TARGET,
  isBlankTerminalTarget,
  resolveLaunchProfile,
  resolveLaunchTarget,
  terminalLaunchTarget,
} from "./target";

const claude: TerminalProfile = {
  id: "claude",
  name: "Claude Code",
  command: "claude",
  args: ["{{{prompt}}}"],
};
const codex: TerminalProfile = {
  id: "codex",
  name: "Codex",
  command: "codex",
  args: ["{{{prompt}}}"],
};
const profiles = [claude, codex];

describe("resolveLaunchTarget", () => {
  it("defaults to chat when nothing is persisted", () => {
    expect(resolveLaunchTarget(undefined, profiles)).toEqual(CHAT_LAUNCH_TARGET);
  });

  it("keeps chat as chat", () => {
    expect(resolveLaunchTarget(CHAT_LAUNCH_TARGET, profiles)).toEqual(CHAT_LAUNCH_TARGET);
  });

  it("keeps a terminal target whose profile still resolves", () => {
    const target = terminalLaunchTarget("codex");
    expect(resolveLaunchTarget(target, profiles)).toEqual(target);
  });

  it("keeps the blank terminal, which is never resolved against profiles", () => {
    const target = terminalLaunchTarget(BLANK_TERMINAL_PROFILE_ID);
    expect(resolveLaunchTarget(target, [])).toEqual(target);
  });

  it("falls back to chat when the persisted profile no longer exists", () => {
    expect(resolveLaunchTarget(terminalLaunchTarget("removed-profile"), profiles)).toEqual(
      CHAT_LAUNCH_TARGET,
    );
  });

  it("falls back to chat when every profile has been removed", () => {
    expect(resolveLaunchTarget(terminalLaunchTarget("codex"), [])).toEqual(CHAT_LAUNCH_TARGET);
  });
});

describe("resolveLaunchProfile", () => {
  it("returns null for chat", () => {
    expect(resolveLaunchProfile(CHAT_LAUNCH_TARGET, profiles)).toBeNull();
  });

  it("returns null for the blank terminal, which runs no command", () => {
    expect(
      resolveLaunchProfile(terminalLaunchTarget(BLANK_TERMINAL_PROFILE_ID), profiles),
    ).toBeNull();
  });

  it("returns the matching profile", () => {
    expect(resolveLaunchProfile(terminalLaunchTarget("claude"), profiles)).toBe(claude);
  });

  it("returns null when the profile id matches nothing", () => {
    expect(resolveLaunchProfile(terminalLaunchTarget("missing"), profiles)).toBeNull();
  });
});

describe("isBlankTerminalTarget", () => {
  it("is true only for a terminal target carrying the blank id", () => {
    expect(isBlankTerminalTarget(terminalLaunchTarget(BLANK_TERMINAL_PROFILE_ID))).toBe(true);
    expect(isBlankTerminalTarget(terminalLaunchTarget("claude"))).toBe(false);
    expect(isBlankTerminalTarget(CHAT_LAUNCH_TARGET)).toBe(false);
  });
});
