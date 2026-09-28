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

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchUsage } from "./usage.js";

function fixtureFetch(expectedToken: string): typeof fetch {
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${expectedToken}` });
    return new Response(JSON.stringify({ five_hour: { utilization: 12 } }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("Claude usage input forms", () => {
  it("reads only the selected configDir file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-usage-input-"));
    try {
      writeFileSync(
        join(dir, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: "fixture-file" } }),
      );
      expect((await fetchUsage({ configDir: dir }, fixtureFetch("fixture-file"))).status).toBe(
        "available",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("uses an accessToken without reading a file", async () => {
    expect(
      (await fetchUsage({ accessToken: "fixture-direct" }, fixtureFetch("fixture-direct"))).status,
    ).toBe("available");
  });
  it("default discovery reads the credential file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-usage-default-"));
    try {
      writeFileSync(
        join(dir, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: "fixture-default" } }),
      );
      vi.stubEnv("CLAUDE_HOME", dir);
      expect((await fetchUsage({}, fixtureFetch("fixture-default"))).status).toBe("available");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("stays unavailable when non-default configDir has no credentials", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-empty-config-"));
    try {
      const fetchApi = vi.fn() as unknown as typeof fetch;
      expect((await fetchUsage({ configDir: dir }, fetchApi)).status).toBe("unavailable");
      expect(fetchApi).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Claude Keychain token usage", () => {
  it("returns unavailable on 401 without attempting refresh", async () => {
    const run = vi.fn(async () =>
      JSON.stringify({
        claudeAiOauth: { accessToken: "fixture-expired", refreshToken: "fixture-refresh" },
      }),
    );
    const credentials = await readClaudeKeychainCredentials(run, "fixture-account");
    const token = (credentials as { claudeAiOauth: { accessToken: string } }).claudeAiOauth
      .accessToken;
    const fetchApi = vi.fn(
      async () => new Response(null, { status: 401 }),
    ) as unknown as typeof fetch;
    const report = await fetchUsage({ accessToken: token }, fetchApi);
    expect(report.status).toBe("unavailable");
    expect(fetchApi).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
