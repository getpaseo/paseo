import { describe, expect, test, vi } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";

import {
  buildProviderCommand,
  resolveProviderResumeCommand,
} from "@/utils/provider-command-templates";

function snapshotEntry(
  provider: string,
  derivedFromProviderId?: string | null,
  launchSource: ProviderSnapshotEntry["launchSource"] = "default",
): Pick<ProviderSnapshotEntry, "provider" | "derivedFromProviderId" | "launchSource"> {
  return { provider, derivedFromProviderId, launchSource };
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
        providerSnapshot: [snapshotEntry("my-claude", "claude", "default")],
      }),
    ).toBe("claude --resume example-session");
  });

  test("falls back to the derived provider template for a custom Codex provider", () => {
    expect(
      buildProviderCommand({
        provider: "my-codex",
        id: "resume",
        sessionId: "example-session",
        providerSnapshot: [snapshotEntry("my-codex", "codex", "default")],
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
        providerSnapshot: [snapshotEntry("my-agent", null, "default")],
      }),
    ).toBeNull();
  });

  test("refuses the built-in template when the snapshot says the command is overridden", () => {
    expect(
      buildProviderCommand({
        provider: "claude",
        id: "resume",
        sessionId: "example-session",
        providerSnapshot: [snapshotEntry("claude", null, "override")],
      }),
    ).toBeNull();
  });

  test("refuses the inherited template for a custom provider that overrides its command", () => {
    expect(
      buildProviderCommand({
        provider: "my-codex",
        id: "resume",
        sessionId: "example-session",
        providerSnapshot: [snapshotEntry("my-codex", "codex", "override")],
      }),
    ).toBeNull();
  });

  test("refuses the inherited template for a custom provider that appends to its command", () => {
    expect(
      buildProviderCommand({
        provider: "my-codex",
        id: "resume",
        sessionId: "example-session",
        providerSnapshot: [snapshotEntry("my-codex", "codex", "append")],
      }),
    ).toBeNull();
  });
});

describe("resolveProviderResumeCommand", () => {
  test("resolves built-in Codex immediately without a snapshot", async () => {
    const getProviderSnapshot = vi.fn().mockResolvedValue(undefined);
    await expect(
      resolveProviderResumeCommand({
        provider: "codex",
        sessionId: "example-session",
        supportsProviderAncestry: false,
        getProviderSnapshot,
      }),
    ).resolves.toBe("codex resume example-session");
    expect(getProviderSnapshot).not.toHaveBeenCalled();
  });

  test("resolves built-in Claude immediately without a snapshot", async () => {
    const getProviderSnapshot = vi.fn().mockResolvedValue(undefined);
    await expect(
      resolveProviderResumeCommand({
        provider: "claude",
        sessionId: "example-session",
        supportsProviderAncestry: false,
        getProviderSnapshot,
      }),
    ).resolves.toBe("claude --resume example-session");
    expect(getProviderSnapshot).not.toHaveBeenCalled();
  });

  test("rejects an inherited custom provider when the daemon does not advertise providerAncestry", async () => {
    const getProviderSnapshot = vi.fn().mockResolvedValue(undefined);
    await expect(
      resolveProviderResumeCommand({
        provider: "my-codex",
        sessionId: "example-session",
        supportsProviderAncestry: false,
        getProviderSnapshot,
      }),
    ).rejects.toThrow("Resume command not available");
    expect(getProviderSnapshot).not.toHaveBeenCalled();
  });

  test("falls back to the ancestor template for a custom provider when providerAncestry is advertised", async () => {
    const getProviderSnapshot = vi
      .fn()
      .mockResolvedValue([snapshotEntry("my-codex", "codex", "default")]);
    await expect(
      resolveProviderResumeCommand({
        provider: "my-codex",
        sessionId: "example-session",
        supportsProviderAncestry: true,
        getProviderSnapshot,
      }),
    ).resolves.toBe("codex resume example-session");
    expect(getProviderSnapshot).toHaveBeenCalledOnce();
  });

  test("rejects a custom provider with an overridden command even when ancestry is advertised", async () => {
    const getProviderSnapshot = vi
      .fn()
      .mockResolvedValue([snapshotEntry("my-codex", "codex", "override")]);
    await expect(
      resolveProviderResumeCommand({
        provider: "my-codex",
        sessionId: "example-session",
        supportsProviderAncestry: true,
        getProviderSnapshot,
      }),
    ).rejects.toThrow("Resume command not available");
  });
});
