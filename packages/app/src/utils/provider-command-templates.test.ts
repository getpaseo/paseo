import { describe, expect, test } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";

import { buildProviderCommand } from "@/utils/provider-command-templates";

function snapshotEntry(
  provider: string,
  derivedFromProviderId?: string | null,
): Pick<ProviderSnapshotEntry, "provider" | "derivedFromProviderId"> {
  return { provider, derivedFromProviderId };
}

describe("buildProviderCommand", () => {
  test("builds Hermes resume commands from native session ids", () => {
    expect(
      buildProviderCommand({
        provider: "hermes",
        id: "resume",
        sessionId: "20260813_111500_abc123",
      }),
    ).toBe("hermes --resume 20260813_111500_abc123");
  });

  test("builds OpenCode resume commands from native session ids", () => {
    expect(
      buildProviderCommand({
        provider: "opencode",
        id: "resume",
        sessionId: "ses_abc123",
      }),
    ).toBe("opencode --session ses_abc123");
  });

  test("builds Claude resume commands for built-in Claude without a snapshot", () => {
    expect(
      buildProviderCommand({
        provider: "claude",
        id: "resume",
        sessionId: "example-session",
      }),
    ).toBe("claude --resume example-session");
  });

  test("builds Codex resume commands for built-in Codex without a snapshot", () => {
    expect(
      buildProviderCommand({
        provider: "codex",
        id: "resume",
        sessionId: "example-session",
      }),
    ).toBe("codex resume example-session");
  });

  test("builds Pi resume commands for built-in Pi without a snapshot", () => {
    expect(
      buildProviderCommand({
        provider: "pi",
        id: "resume",
        sessionId: "example-session",
      }),
    ).toBe("pi --session example-session");
  });

  test("builds OMP resume commands for built-in OMP without a snapshot", () => {
    expect(
      buildProviderCommand({
        provider: "omp",
        id: "resume",
        sessionId: "example-session",
      }),
    ).toBe("omp --session example-session");
  });

  test("falls back to the derived provider template for a custom Claude provider", () => {
    expect(
      buildProviderCommand({
        provider: "my-claude",
        id: "resume",
        sessionId: "example-session",
        providerSnapshot: [snapshotEntry("my-claude", "claude")],
      }),
    ).toBe("claude --resume example-session");
  });

  test("falls back to the derived provider template for a custom Codex provider", () => {
    expect(
      buildProviderCommand({
        provider: "my-codex",
        id: "resume",
        sessionId: "example-session",
        providerSnapshot: [snapshotEntry("my-codex", "codex")],
      }),
    ).toBe("codex resume example-session");
  });

  test("returns null for an unknown provider with no derivable template", () => {
    expect(
      buildProviderCommand({
        provider: "unknown",
        id: "resume",
        sessionId: "example-session",
      }),
    ).toBeNull();
  });

  test("returns null for a custom ACP provider that does not extend a templated provider", () => {
    expect(
      buildProviderCommand({
        provider: "my-agent",
        id: "resume",
        sessionId: "example-session",
        providerSnapshot: [snapshotEntry("my-agent", null)],
      }),
    ).toBeNull();
  });
});
