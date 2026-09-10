import { describe, expect, test } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";

import {
  buildProviderCommand,
  ProviderResumeCommandUnavailableError,
  resolveProviderResumeCommand,
} from "@/utils/provider-command-templates";

function snapshotEntry(
  provider: string,
  derivedFromProviderId?: string | null,
  launchSource: ProviderSnapshotEntry["launchSource"] = "default",
): Pick<ProviderSnapshotEntry, "provider" | "derivedFromProviderId" | "launchSource"> {
  return { provider, derivedFromProviderId, launchSource };
}

const neverCalledSnapshot = () =>
  Promise.reject(new Error("getProviderSnapshot should not have been called"));

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
    await expect(
      resolveProviderResumeCommand({
        provider: "codex",
        sessionId: "example-session",
        supportsProviderAncestry: false,
        getProviderSnapshot: neverCalledSnapshot,
      }),
    ).resolves.toBe("codex resume example-session");
  });

  test("resolves built-in Claude immediately without a snapshot", async () => {
    await expect(
      resolveProviderResumeCommand({
        provider: "claude",
        sessionId: "example-session",
        supportsProviderAncestry: false,
        getProviderSnapshot: neverCalledSnapshot,
      }),
    ).resolves.toBe("claude --resume example-session");
  });

  test("resolves built-in Codex with providerAncestry without a snapshot", async () => {
    await expect(
      resolveProviderResumeCommand({
        provider: "codex",
        sessionId: "example-session",
        supportsProviderAncestry: true,
        getProviderSnapshot: neverCalledSnapshot,
      }),
    ).resolves.toBe("codex resume example-session");
  });

  test("rejects a custom provider when providerAncestry is not advertised", async () => {
    await expect(
      resolveProviderResumeCommand({
        provider: "my-codex",
        sessionId: "example-session",
        supportsProviderAncestry: false,
        getProviderSnapshot: neverCalledSnapshot,
      }),
    ).rejects.toThrow(ProviderResumeCommandUnavailableError);
  });

  test("falls back to the ancestor template for a custom provider when providerAncestry is advertised", async () => {
    await expect(
      resolveProviderResumeCommand({
        provider: "my-codex",
        sessionId: "example-session",
        supportsProviderAncestry: true,
        getProviderSnapshot: () => Promise.resolve([snapshotEntry("my-codex", "codex", "default")]),
      }),
    ).resolves.toBe("codex resume example-session");
  });

  test("rejects a custom provider with an overridden command even when ancestry is advertised", async () => {
    await expect(
      resolveProviderResumeCommand({
        provider: "my-codex",
        sessionId: "example-session",
        supportsProviderAncestry: true,
        getProviderSnapshot: () =>
          Promise.resolve([snapshotEntry("my-codex", "codex", "override")]),
      }),
    ).rejects.toThrow(ProviderResumeCommandUnavailableError);
  });

  test("rejects a custom provider that appends to its command", async () => {
    await expect(
      resolveProviderResumeCommand({
        provider: "my-codex",
        sessionId: "example-session",
        supportsProviderAncestry: true,
        getProviderSnapshot: () => Promise.resolve([snapshotEntry("my-codex", "codex", "append")]),
      }),
    ).rejects.toThrow(ProviderResumeCommandUnavailableError);
  });

  test("rejects a custom provider with an absent launchSource", async () => {
    await expect(
      resolveProviderResumeCommand({
        provider: "my-codex",
        sessionId: "example-session",
        supportsProviderAncestry: true,
        getProviderSnapshot: () =>
          Promise.resolve([{ ...snapshotEntry("my-codex", "codex"), launchSource: undefined }]),
      }),
    ).rejects.toThrow(ProviderResumeCommandUnavailableError);
  });

  test("does not silently reuse a fallback command when the snapshot source is unavailable", async () => {
    await expect(
      resolveProviderResumeCommand({
        provider: "my-codex",
        sessionId: "example-session",
        supportsProviderAncestry: true,
        getProviderSnapshot: () => Promise.resolve(undefined),
      }),
    ).rejects.toThrow(ProviderResumeCommandUnavailableError);
  });

  test("propagates unexpected snapshot errors instead of masking them as unavailable", async () => {
    await expect(
      resolveProviderResumeCommand({
        provider: "my-codex",
        sessionId: "example-session",
        supportsProviderAncestry: true,
        getProviderSnapshot: () => Promise.reject(new Error("network failure")),
      }),
    ).rejects.toThrow("network failure");
  });
});
