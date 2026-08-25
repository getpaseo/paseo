import { describe, expect, it } from "vitest";
import {
  resolveCodexAccountChange,
  resolveCodexAccountReloadNotice,
  shouldPromptCodexAccountChange,
  type CodexAccountChangePromptState,
} from "./codex-account-change";

describe("resolveCodexAccountChange", () => {
  it("reads a complete Codex account transition", () => {
    expect(
      resolveCodexAccountChange({
        provider: "codex",
        sessionId: "thread-1",
        extra: {
          codexAccountChange: {
            previousLabel: "old@example.com",
            nextLabel: "new@example.com",
            revision: 4,
          },
        },
      }),
    ).toEqual({
      previousLabel: "old@example.com",
      nextLabel: "new@example.com",
      revision: 4,
      key: "old@example.com\u0000new@example.com\u00004",
    });
  });

  it("ignores incomplete runtime metadata", () => {
    expect(
      resolveCodexAccountChange({
        provider: "codex",
        sessionId: "thread-1",
        extra: { codexAccountChange: { previousLabel: "old@example.com" } },
      }),
    ).toBeNull();
  });
});

describe("resolveCodexAccountReloadNotice", () => {
  const accountChange = {
    previousLabel: "old@example.com",
    nextLabel: "new@example.com",
    revision: 1,
    key: "old@example.com\u0000new@example.com\u00001",
  };

  it("accepts only an account verified by the new app-server", () => {
    expect(
      resolveCodexAccountReloadNotice(
        {
          providerAccountLabel: "new@example.com",
          providerAccountVerificationStatus: "verified",
        },
        accountChange,
      ),
    ).toEqual({ kind: "verified", account: "new@example.com" });
  });

  it("reports the account returned by the new app-server when it differs", () => {
    expect(
      resolveCodexAccountReloadNotice(
        {
          providerAccountLabel: "old@example.com",
          providerAccountVerificationStatus: "mismatch",
        },
        accountChange,
      ),
    ).toEqual({
      kind: "mismatch",
      actualAccount: "old@example.com",
      expectedAccount: "new@example.com",
    });
  });

  it("does not claim success without app-server verification", () => {
    expect(
      resolveCodexAccountReloadNotice(
        {
          providerAccountLabel: "new@example.com",
          providerAccountVerificationStatus: "unavailable",
        },
        accountChange,
      ),
    ).toEqual({ kind: "unverified" });
  });
});

describe("shouldPromptCodexAccountChange", () => {
  const ready: CodexAccountChangePromptState = {
    accountChange: {
      previousLabel: "old@example.com",
      nextLabel: "new@example.com",
      revision: 1,
      key: "old@example.com\u0000new@example.com\u00001",
    },
    agentId: "agent-1",
    provider: "codex",
    status: "idle",
    archived: false,
    isInitializing: false,
    isConnected: true,
    isPaneVisible: true,
    isPaneFocused: true,
    promptedKey: null,
  };

  it("prompts for an idle focused Codex agent", () => {
    expect(shouldPromptCodexAccountChange(ready)).toBe(true);
  });

  it("waits for a running agent to become idle", () => {
    expect(shouldPromptCodexAccountChange({ ...ready, status: "running" })).toBe(false);
  });

  it("does not prompt hidden panes or repeat an answered transition", () => {
    expect(shouldPromptCodexAccountChange({ ...ready, isPaneVisible: false })).toBe(false);
    expect(
      shouldPromptCodexAccountChange({ ...ready, promptedKey: ready.accountChange!.key }),
    ).toBe(false);
  });
});
