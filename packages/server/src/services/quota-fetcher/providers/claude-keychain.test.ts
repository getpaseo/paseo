import { describe, expect, it, vi } from "vitest";
import { claudeKeychainAccount, readClaudeKeychainCredentials } from "./claude.js";

const SERVICE = "Claude Code-credentials";

describe("claudeKeychainAccount", () => {
  // Claude Code derives the Keychain account from $USER, but only accepts the characters
  // a Keychain account may carry. Paseo has to reproduce the derivation exactly or it
  // looks up an account nothing was ever written under.
  it("uses the username when the Keychain accepts it verbatim", () => {
    expect(claudeKeychainAccount("thomas.benoit")).toBe("thomas.benoit");
  });

  // Corporate logins are email addresses, and "@" fails Claude Code's pattern. This is
  // the case that produced the bug: the account is not the username here.
  it("falls back to claude-code-user when the username carries a rejected character", () => {
    expect(claudeKeychainAccount("thomas.benoit@yousign.com")).toBe("claude-code-user");
  });
});

describe("readClaudeKeychainCredentials", () => {
  // The regression this guards: several items share the service name, one per account
  // convention Claude Code has used over time. A lookup without "-a" returns whichever
  // one the Keychain finds first — in practice the oldest, whose token expired months
  // ago. Naming the account is what selects the item Claude Code actually writes.
  it("looks the item up by account and stops there when it exists", async () => {
    const run = vi.fn(async () => JSON.stringify({ claudeAiOauth: { accessToken: "at_fresh" } }));

    const credentials = await readClaudeKeychainCredentials(run, "claude-code-user");

    expect(credentials).toEqual({ claudeAiOauth: { accessToken: "at_fresh" } });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith([
      "find-generic-password",
      "-a",
      "claude-code-user",
      "-w",
      "-s",
      SERVICE,
    ]);
  });

  // Claude Code versions before the account convention wrote the item with no account we
  // can predict, so the account-less lookup stays as a fallback — but only as one.
  it("falls back to the account-less lookup when no item matches the account", async () => {
    const run = vi.fn(async (args: string[]) =>
      args.includes("-a") ? null : JSON.stringify({ claudeAiOauth: { accessToken: "at_legacy" } }),
    );

    const credentials = await readClaudeKeychainCredentials(run, "claude-code-user");

    expect(credentials).toEqual({ claudeAiOauth: { accessToken: "at_legacy" } });
    expect(run).toHaveBeenNthCalledWith(2, ["find-generic-password", "-w", "-s", SERVICE]);
  });

  it("is null when the Keychain holds no item at all", async () => {
    const run = vi.fn(async () => null);

    expect(await readClaudeKeychainCredentials(run, "claude-code-user")).toBeNull();
  });

  // A truncated or non-JSON blob must not shadow an item a later lookup could still read.
  it("tries the next lookup when the item does not parse", async () => {
    const run = vi.fn(async (args: string[]) =>
      args.includes("-a") ? "not-json" : JSON.stringify({ claudeAiOauth: {} }),
    );

    expect(await readClaudeKeychainCredentials(run, "claude-code-user")).toEqual({
      claudeAiOauth: {},
    });
  });
});
