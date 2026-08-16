import { describe, expect, it } from "vitest";
import { OptimisticFormPreferences } from "./optimistic-preferences";

describe("optimistic form preferences", () => {
  it("removes a rejected update while preserving later queued updates", () => {
    const preferences = new OptimisticFormPreferences({});
    const failed = preferences.begin({ provider: "claude" });
    const pending = preferences.begin({ runtimeId: "worktree" });

    expect(preferences.current()).toEqual({ provider: "claude", runtimeId: "worktree" });

    preferences.reject(failed);
    expect(preferences.current()).toEqual({ runtimeId: "worktree" });

    preferences.commit(pending, { runtimeId: "worktree" });
    expect(preferences.current()).toEqual({ runtimeId: "worktree" });
  });

  it("does not replace pending optimistic state with a stale external snapshot", () => {
    const preferences = new OptimisticFormPreferences({ provider: "codex" });
    const pending = preferences.begin({ provider: "claude" });

    preferences.reconcile({ provider: "codex", runtimeId: "local" });
    expect(preferences.current()).toEqual({ provider: "claude" });

    preferences.commit(pending, { provider: "claude" });
    preferences.reconcile({ provider: "claude", runtimeId: "worktree" });
    expect(preferences.current()).toEqual({ provider: "claude", runtimeId: "worktree" });
  });
});
