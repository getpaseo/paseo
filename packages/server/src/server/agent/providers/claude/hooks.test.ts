import { describe, expect, it, vi } from "vitest";

import { mergeClaudeHooks } from "./hooks.js";

describe("mergeClaudeHooks", () => {
  const own = { PreToolUse: [{ hooks: [vi.fn()] }] } as never;

  it("keeps Paseo's hooks when the user configured none", () => {
    expect(mergeClaudeHooks(own, undefined)).toEqual(own);
    expect(mergeClaudeHooks(own, null)).toEqual(own);
  });

  it("appends user hooks for the same event instead of replacing them", () => {
    const userHook = vi.fn();
    const merged = mergeClaudeHooks(own, { PreToolUse: [{ hooks: [userHook] }] }) as {
      PreToolUse: unknown[];
    };
    // Both must survive: dropping Paseo's would silently stop effort being observed, and
    // dropping the user's would break their configuration.
    expect(merged.PreToolUse).toHaveLength(2);
  });

  it("carries through events Paseo does not register", () => {
    const merged = mergeClaudeHooks(own, { SessionStart: [{ hooks: [vi.fn()] }] }) as Record<
      string,
      unknown[]
    >;
    expect(merged.SessionStart).toHaveLength(1);
    expect(merged.PreToolUse).toHaveLength(1);
  });

  it("ignores malformed entries rather than throwing", () => {
    expect(mergeClaudeHooks(own, { PreToolUse: "not-an-array" })).toEqual(own);
    expect(mergeClaudeHooks(own, "nonsense")).toEqual(own);
  });
});
