import { describe, expect, it, vi } from "vitest";
import { refreshKimiCredentialsIfNeeded, type KimiCredentialSnapshot } from "./refresher.js";

function snapshot(overrides: Partial<KimiCredentialSnapshot> = {}): KimiCredentialSnapshot {
  return {
    path: "/tmp/kimi-code.json",
    exists: true,
    expiresAtMs: 1_000_000,
    hasAccessToken: true,
    hasRefreshToken: true,
    ...overrides,
  };
}

describe("Kimi credential refresher", () => {
  it("launches the CLI when file credentials are inside the refresh window", async () => {
    let current = snapshot();
    const launchRefresh = vi.fn(async () => {
      current = snapshot({ expiresAtMs: 2_000_000 });
      return { ok: true };
    });

    const outcome = await refreshKimiCredentialsIfNeeded({
      now: () => 900_000,
      leadMs: 180_000,
      readCredentials: async () => current,
      launchRefresh,
    });

    expect(launchRefresh).toHaveBeenCalledOnce();
    expect(outcome).toEqual({ status: "refreshed", expiresAtMs: 2_000_000 });
  });

  it("does nothing while the access token is outside the refresh window", async () => {
    const launchRefresh = vi.fn(async () => ({ ok: true }));
    const outcome = await refreshKimiCredentialsIfNeeded({
      now: () => 500_000,
      leadMs: 180_000,
      readCredentials: async () => snapshot(),
      launchRefresh,
    });

    expect(outcome).toEqual({ status: "not-needed" });
    expect(launchRefresh).not.toHaveBeenCalled();
  });

  it("does not launch the CLI without a refresh token", async () => {
    const launchRefresh = vi.fn(async () => ({ ok: true }));
    const outcome = await refreshKimiCredentialsIfNeeded({
      now: () => 1_000_001,
      readCredentials: async () => snapshot({ hasRefreshToken: false }),
      launchRefresh,
    });

    expect(outcome).toEqual({ status: "login-required" });
    expect(launchRefresh).not.toHaveBeenCalled();
  });

  it("does not manage credentials supplied through environment variables", async () => {
    const previous = process.env.KIMI_TOKEN;
    process.env.KIMI_TOKEN = "fixture";
    try {
      const launchRefresh = vi.fn(async () => ({ ok: true }));
      const outcome = await refreshKimiCredentialsIfNeeded({
        readCredentials: async () => snapshot({ exists: false, hasAccessToken: false }),
        launchRefresh,
      });
      expect(outcome).toEqual({ status: "external-token" });
      expect(launchRefresh).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.KIMI_TOKEN;
      else process.env.KIMI_TOKEN = previous;
    }
  });

  it("reports a launch failure without claiming the credential was refreshed", async () => {
    const outcome = await refreshKimiCredentialsIfNeeded({
      now: () => 1_000_001,
      readCredentials: async () => snapshot(),
      launchRefresh: async () => ({ ok: false, error: "kimi web exited" }),
    });

    expect(outcome).toEqual({ status: "failed", error: "kimi web exited" });
  });
});
