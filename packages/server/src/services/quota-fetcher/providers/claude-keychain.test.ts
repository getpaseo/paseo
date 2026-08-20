import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeKeychainAccount, readClaudeKeychainCredentials } from "./claude.js";

const SERVICE = "Claude Code-credentials";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("claudeKeychainAccount", () => {
  it("uses a supported username verbatim", () => {
    expect(claudeKeychainAccount("thomas.benoit")).toBe("thomas.benoit");
  });

  it("falls back to claude-code-user when the username carries a rejected character", () => {
    expect(claudeKeychainAccount("first.last@example.com")).toBe("claude-code-user");
  });

  it("reads the username from $USER when no account is given", () => {
    vi.stubEnv("USER", "ci-runner");
    expect(claudeKeychainAccount()).toBe("ci-runner");

    vi.stubEnv("USER", "first.last@example.com");
    expect(claudeKeychainAccount()).toBe("claude-code-user");
  });
});

describe("readClaudeKeychainCredentials", () => {
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

  it("falls back to the account-less lookup when no item matches the account", async () => {
    const run = vi.fn(async (args: string[]) =>
      args.includes("-a") ? null : JSON.stringify({ claudeAiOauth: { accessToken: "at_legacy" } }),
    );

    const credentials = await readClaudeKeychainCredentials(run, "claude-code-user");

    expect(credentials).toEqual({ claudeAiOauth: { accessToken: "at_legacy" } });
    expect(run).toHaveBeenNthCalledWith(2, ["find-generic-password", "-w", "-s", SERVICE]);
  });

  it("falls through when the account item carries no access token", async () => {
    const run = vi.fn(async (args: string[]) =>
      args.includes("-a")
        ? JSON.stringify({ claudeAiOauth: { subscriptionType: "team" } })
        : JSON.stringify({ claudeAiOauth: { accessToken: "at_legacy" } }),
    );

    const credentials = await readClaudeKeychainCredentials(run, "claude-code-user");

    expect(credentials).toEqual({ claudeAiOauth: { accessToken: "at_legacy" } });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("is null when the Keychain holds no item at all", async () => {
    const run = vi.fn(async () => null);

    expect(await readClaudeKeychainCredentials(run, "claude-code-user")).toBeNull();
  });

  it("tries the next lookup when the item does not parse", async () => {
    const run = vi.fn(async (args: string[]) =>
      args.includes("-a")
        ? "not-json"
        : JSON.stringify({ claudeAiOauth: { accessToken: "at_legacy" } }),
    );

    expect(await readClaudeKeychainCredentials(run, "claude-code-user")).toEqual({
      claudeAiOauth: { accessToken: "at_legacy" },
    });
  });
});
