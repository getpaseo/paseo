import { describe, expect, it } from "vitest";

import { buildProviderAuthRecoveryGuidance, isProviderAuthError } from "./auth-error.js";

describe("isProviderAuthError", () => {
  it.each([
    "Failed to authenticate. API Error: 401 OAuth access token has been revoked.",
    "Failed to authenticate: OAuth session expired and could not be refreshed",
    "Not logged in · Please run /login",
    "OAuth token has expired",
    "API error: 401 invalid api key",
    "authentication_error: credentials rejected",
  ])("classifies %j as an auth failure", (message) => {
    expect(isProviderAuthError(message)).toBe(true);
  });

  it.each([
    "Claude stopped unexpectedly (exit code 1).",
    "Tool call failed: ENOENT",
    // Loose tokens must stay tied to an auth-ish neighbour, or ordinary output
    // that happens to quote them would be misread as an expired credential.
    "server.ts:401 unauthorized_user_ids is not defined",
    "Request failed with status 500",
    "",
    undefined,
    null,
  ])("does not classify %j", (message) => {
    expect(isProviderAuthError(message)).toBe(false);
  });
});

describe("buildProviderAuthRecoveryGuidance", () => {
  it("names the provider and gives its exact login steps", () => {
    const guidance = buildProviderAuthRecoveryGuidance({ provider: "claude" });
    expect(guidance).toContain("Claude Code");
    expect(guidance).toContain("/logout");
    expect(guidance).toContain("/login");
  });

  it("distinguishes the credential from unrelated logins", () => {
    const guidance = buildProviderAuthRecoveryGuidance({ provider: "codex" });
    expect(guidance).toContain("codex login");
    expect(guidance).toMatch(/not your Paseo, Git forge, or cloud CLI login/);
  });

  it("falls back to the provider id when the runtime is unknown", () => {
    const guidance = buildProviderAuthRecoveryGuidance({ provider: "acme-agent" });
    expect(guidance).toContain("acme-agent");
    expect(guidance).toContain("login flow in a terminal");
  });

  it("prefers an explicit label over the built-in default", () => {
    const guidance = buildProviderAuthRecoveryGuidance({
      provider: "claude",
      providerLabel: "Claude (work profile)",
    });
    expect(guidance).toContain("Claude (work profile)");
  });
});
