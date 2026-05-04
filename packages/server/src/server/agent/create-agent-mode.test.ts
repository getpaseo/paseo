import { describe, expect, it } from "vitest";
import { resolveAndValidateCreateAgentMode } from "./create-agent-mode.js";

const CLAUDE_MODES = ["default", "acceptEdits", "plan", "bypassPermissions"];
const OPENCODE_MODES = ["build", "full-access", "plan"];
const CODEX_MODES = ["auto", "full-access"];

describe("resolveAndValidateCreateAgentMode", () => {
  it("returns the requested mode when it is valid for the target provider", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: "plan",
      targetProvider: "opencode",
      parent: null,
      availableModes: OPENCODE_MODES,
    });
    expect(resolved).toBe("plan");
  });

  it("throws when the requested mode is invalid for the target provider", () => {
    expect(() =>
      resolveAndValidateCreateAgentMode({
        requestedMode: "bypassPermissions",
        targetProvider: "opencode",
        parent: null,
        availableModes: OPENCODE_MODES,
      }),
    ).toThrow(
      "Invalid mode 'bypassPermissions' for provider 'opencode'. Available modes: build, full-access, plan",
    );
  });

  it("returns undefined (provider default) when no mode and no caller", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: undefined,
      targetProvider: "claude",
      parent: null,
      availableModes: CLAUDE_MODES,
    });
    expect(resolved).toBeUndefined();
  });

  it("inherits the caller mode when caller and target share a provider", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: undefined,
      targetProvider: "claude",
      parent: { provider: "claude", modeId: "bypassPermissions" },
      availableModes: CLAUDE_MODES,
    });
    expect(resolved).toBe("bypassPermissions");
  });

  it("returns undefined when same-provider caller has no mode", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: undefined,
      targetProvider: "claude",
      parent: { provider: "claude", modeId: null },
      availableModes: CLAUDE_MODES,
    });
    expect(resolved).toBeUndefined();
  });

  it("refuses cross-provider inheritance with the target provider's modes in the message", () => {
    expect(() =>
      resolveAndValidateCreateAgentMode({
        requestedMode: undefined,
        targetProvider: "opencode",
        parent: { provider: "claude", modeId: "bypassPermissions" },
        availableModes: OPENCODE_MODES,
      }),
    ).toThrow(
      "cannot inherit mode 'bypassPermissions' from caller (provider 'claude') for new agent (provider 'opencode'). Pass an explicit mode. Available modes for 'opencode': build, full-access, plan",
    );
  });

  it("refuses cross-provider inheritance even when the caller mode is null", () => {
    expect(() =>
      resolveAndValidateCreateAgentMode({
        requestedMode: undefined,
        targetProvider: "codex",
        parent: { provider: "opencode", modeId: null },
        availableModes: CODEX_MODES,
      }),
    ).toThrow(
      "cannot inherit mode '<none>' from caller (provider 'opencode') for new agent (provider 'codex'). Pass an explicit mode. Available modes for 'codex': auto, full-access",
    );
  });

  it("passes through an explicit mode when the target provider's modes are unknown", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: "default",
      targetProvider: "zai-custom",
      parent: null,
      availableModes: undefined,
    });
    expect(resolved).toBe("default");
  });

  it("renders 'unknown' in cross-provider error when target modes are unknown", () => {
    expect(() =>
      resolveAndValidateCreateAgentMode({
        requestedMode: undefined,
        targetProvider: "zai-custom",
        parent: { provider: "claude", modeId: "default" },
        availableModes: undefined,
      }),
    ).toThrow("Available modes for 'zai-custom': unknown");
  });
});
