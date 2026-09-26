import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeKeychainAccount, readClaudeKeychainCredentials } from "./usage.js";

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

describe("Claude usage input forms", () => {
  it("reads only the selected configDir file", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { ClaudeQuotaProvider } = await import("./usage.js");
    const dir = mkdtempSync(join(tmpdir(), "claude-usage-input-"));
    try {
      writeFileSync(
        join(dir, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: "fixture-file" } }),
      );
      const keychain = vi.fn(async () => ({ claudeAiOauth: { accessToken: "fixture-keychain" } }));
      const fetchApi = vi.fn(async (_url: unknown, init: RequestInit) => {
        expect(init.headers).toMatchObject({ Authorization: "Bearer fixture-file" });
        return new Response(JSON.stringify({ five_hour: { utilization: 12 } }), { status: 200 });
      });
      const report = await new ClaudeQuotaProvider({
        logger: console,
        configDir: dir,
        platform: "darwin",
        claudeKeychainReader: keychain,
        fetch: fetchApi as never,
      }).fetchUsage();
      expect(report.status).toBe("available");
      expect(keychain).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses an accessToken without reading a file or keychain", async () => {
    const { ClaudeQuotaProvider } = await import("./usage.js");
    const keychain = vi.fn(async () => null);
    const fetchApi = vi.fn(async (_url: unknown, init: RequestInit) => {
      expect(init.headers).toMatchObject({ Authorization: "Bearer fixture-direct" });
      return new Response(JSON.stringify({ seven_day: { utilization: 25 } }), { status: 200 });
    });
    const report = await new ClaudeQuotaProvider({
      logger: console,
      accessToken: "fixture-direct",
      configDir: "/nonexistent",
      platform: "darwin",
      claudeKeychainReader: keychain,
      fetch: fetchApi as never,
    }).fetchUsage();
    expect(report.status).toBe("available");
    expect(keychain).not.toHaveBeenCalled();
  });

  it("default discovery reads the credential file before keychain", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { ClaudeQuotaProvider } = await import("./usage.js");
    const dir = mkdtempSync(join(tmpdir(), "claude-usage-default-"));
    try {
      writeFileSync(
        join(dir, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: "fixture-default" } }),
      );
      const keychain = vi.fn(async () => ({ claudeAiOauth: { accessToken: "fixture-keychain" } }));
      const fetchApi = vi.fn(async (_url: unknown, init: RequestInit) => {
        expect(init.headers).toMatchObject({ Authorization: "Bearer fixture-default" });
        return new Response(JSON.stringify({ five_hour: { utilization: 7 } }), { status: 200 });
      });
      const report = await new ClaudeQuotaProvider({
        logger: console,
        claudeHome: dir,
        platform: "darwin",
        claudeKeychainReader: keychain,
        fetch: fetchApi as never,
      }).fetchUsage();
      expect(report.status).toBe("available");
      expect(keychain).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Claude non-default config directory", () => {
  it("stays unavailable when its credential file is missing without probing keychain", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { ClaudeQuotaProvider } = await import("./usage.js");
    const dir = mkdtempSync(join(tmpdir(), "claude-empty-config-"));
    try {
      const keychain = vi.fn(async () => ({ claudeAiOauth: { accessToken: "fixture-keychain" } }));
      const fetchApi = vi.fn();
      const report = await new ClaudeQuotaProvider({
        logger: console,
        configDir: dir,
        platform: "darwin",
        claudeKeychainReader: keychain,
        fetch: fetchApi as never,
      }).fetchUsage();
      expect(report.status).toBe("unavailable");
      expect(keychain).not.toHaveBeenCalled();
      expect(fetchApi).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
