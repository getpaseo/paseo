import { describe, expect, test } from "vitest";

import { resolveStructuredGenerationProviders } from "./structured-generation-providers.js";
import type { ProviderSnapshotEntry } from "./agent-sdk-types.js";

const READY = "ready" as const;
const ERROR = "error" as const;

class ProviderSnapshots {
  readonly calls: Array<{ cwd?: string; wait?: boolean }> = [];

  constructor(private readonly entries: ProviderSnapshotEntry[]) {}

  async listProviders(input: { cwd?: string; wait?: boolean } = {}) {
    this.calls.push({ cwd: input.cwd, wait: input.wait });
    return this.entries;
  }
}

describe("resolveStructuredGenerationProviders", () => {
  test("tries Flash before M3 regardless of catalog order and preserves explicit legacy choices", async () => {
    const snapshots = new ProviderSnapshots([
      {
        provider: "opencode",
        status: READY,
        enabled: true,
        models: [
          { provider: "opencode", id: "opencode/minimax-m3", label: "M3" },
          { provider: "opencode", id: "opencode/minimax-m3.1-flash-free", label: "Flash" },
        ],
      },
    ]);
    const providers = await resolveStructuredGenerationProviders({
      cwd: "/workspace/repo",
      providerSnapshotManager: snapshots,
      daemonConfig: {
        metadataGeneration: {
          providers: [{ provider: "opencode", model: "minimax/MiniMax-M2.7" }],
        },
      },
      currentSelection: { provider: "opencode", model: "custom/saved-model" },
    });
    expect(providers.map((provider) => provider.model)).toEqual([
      "minimax/MiniMax-M2.7",
      "opencode/minimax-m3.1-flash-free",
      "opencode/minimax-m3",
      "custom/saved-model",
    ]);
  });

  test("does not use hidden or disabled models as automatic fallbacks", async () => {
    const snapshots = new ProviderSnapshots([
      {
        provider: "opencode",
        status: READY,
        enabled: true,
        models: [
          {
            provider: "opencode",
            id: "opencode/minimax-m3",
            label: "M3",
            isVisibleInPicker: false,
          },
          {
            provider: "opencode",
            id: "opencode/minimax-m3.1-flash-free",
            label: "Flash",
            isSelectable: false,
          },
        ],
      },
    ]);
    expect(
      await resolveStructuredGenerationProviders({
        cwd: "/workspace/repo",
        providerSnapshotManager: snapshots,
      }),
    ).toEqual([]);
  });
  test("tries the configured model before dynamically discovered fallbacks", async () => {
    const snapshots = new ProviderSnapshots([
      {
        provider: "work-claude",
        status: READY,
        enabled: true,
        models: [
          { provider: "work-claude", id: "claude-haiku-2026", label: "Haiku", isDefault: true },
        ],
      },
    ]);

    const providers = await resolveStructuredGenerationProviders({
      cwd: "/tmp/repo",
      providerSnapshotManager: snapshots,
      daemonConfig: {
        metadataGeneration: {
          providers: [{ provider: "mock", model: "ten-second-stream" }],
        },
      },
    });

    expect(providers).toEqual([
      { provider: "mock", model: "ten-second-stream" },
      { provider: "work-claude", model: "claude-haiku-2026" },
    ]);
    expect(snapshots.calls).toEqual([{ cwd: "/tmp/repo", wait: true }]);
  });

  test("falls back to dynamic defaults and current selection when no provider is configured", async () => {
    const snapshots = new ProviderSnapshots([
      {
        provider: "work-claude",
        status: READY,
        enabled: true,
        models: [
          { provider: "work-claude", id: "claude-haiku-2026", label: "Haiku", isDefault: true },
        ],
      },
      {
        provider: "work-codex",
        status: READY,
        enabled: true,
        models: [
          {
            provider: "work-codex",
            id: "gpt-5.4-mini-2026",
            label: "GPT 5.4 Mini",
            isDefault: true,
            thinkingOptions: [
              { id: "low", label: "Low" },
              { id: "medium", label: "Medium", isDefault: true },
            ],
            defaultThinkingOptionId: "medium",
          },
        ],
      },
      {
        provider: "router",
        status: READY,
        enabled: true,
        models: [
          { provider: "router", id: "minimax-m3-free", label: "MiniMax M3", isDefault: true },
          { provider: "router", id: "nemotron-3-super-free", label: "Nemotron 3 Super" },
        ],
      },
    ]);

    const providers = await resolveStructuredGenerationProviders({
      cwd: "/tmp/repo",
      providerSnapshotManager: snapshots,
      currentSelection: {
        provider: "focused-provider",
        model: "focused-model",
        thinkingOptionId: "high",
      },
    });

    expect(providers).toEqual([
      { provider: "work-claude", model: "claude-haiku-2026" },
      { provider: "work-codex", model: "gpt-5.4-mini-2026", thinkingOptionId: "low" },
      { provider: "router", model: "minimax-m3-free" },
      { provider: "router", model: "nemotron-3-super-free" },
      { provider: "focused-provider", model: "focused-model", thinkingOptionId: "high" },
    ]);
    expect(snapshots.calls).toEqual([{ cwd: "/tmp/repo", wait: true }]);
  });

  test("falls back to the current selection when defaults do not match", async () => {
    const snapshots = new ProviderSnapshots([
      {
        provider: "current-provider",
        status: READY,
        enabled: true,
        models: [
          {
            provider: "current-provider",
            id: "selected-model",
            label: "Selected Model",
            isDefault: true,
          },
        ],
      },
    ]);

    const providers = await resolveStructuredGenerationProviders({
      cwd: "/tmp/repo",
      providerSnapshotManager: snapshots,
      currentSelection: {
        provider: "current-provider",
        model: "selected-model",
        thinkingOptionId: "medium",
      },
    });

    expect(providers).toEqual([
      { provider: "current-provider", model: "selected-model", thinkingOptionId: "medium" },
    ]);
  });

  test("resolves a provider-only current selection to that provider's default model", async () => {
    const snapshots = new ProviderSnapshots([
      {
        provider: "focused-provider",
        status: READY,
        enabled: true,
        models: [
          {
            provider: "focused-provider",
            id: "focused-default",
            label: "Focused Default",
            isDefault: true,
            defaultThinkingOptionId: "balanced",
          },
        ],
      },
    ]);

    const providers = await resolveStructuredGenerationProviders({
      cwd: "/tmp/repo",
      providerSnapshotManager: snapshots,
      currentSelection: { provider: "focused-provider" },
    });

    expect(providers).toEqual([
      { provider: "focused-provider", model: "focused-default", thinkingOptionId: "balanced" },
    ]);
  });

  test("normalizes configured nested-provider aliases from the provider snapshot", async () => {
    const snapshots = new ProviderSnapshots([
      {
        provider: "opencode",
        status: READY,
        enabled: true,
        models: [
          {
            provider: "opencode",
            id: "plexus/small-fast",
            label: "Small Fast",
            isDefault: true,
            metadata: {
              providerId: "plexus",
              modelId: "small-fast",
            },
          },
        ],
      },
    ]);

    const providers = await resolveStructuredGenerationProviders({
      cwd: "/tmp/repo",
      providerSnapshotManager: snapshots,
      daemonConfig: {
        metadataGeneration: {
          providers: [{ provider: "plexus", model: "small-fast" }],
        },
      },
    });

    expect(providers).toEqual([{ provider: "opencode", model: "plexus/small-fast" }]);
    expect(snapshots.calls).toEqual([{ cwd: "/tmp/repo", wait: true }]);
  });

  test("keeps explicit candidates when provider snapshots are in error state", async () => {
    const snapshots = new ProviderSnapshots([
      {
        provider: "current-provider",
        status: ERROR,
        enabled: true,
        error: "timed out",
      },
    ]);

    const providers = await resolveStructuredGenerationProviders({
      cwd: "/tmp/repo",
      providerSnapshotManager: snapshots,
      daemonConfig: {
        metadataGeneration: {
          providers: [{ provider: "current-provider", model: "configured-model" }],
        },
      },
      currentSelection: {
        provider: "current-provider",
        model: "selected-model",
        thinkingOptionId: "medium",
      },
    });

    expect(providers).toEqual([
      { provider: "current-provider", model: "configured-model" },
      { provider: "current-provider", model: "selected-model", thinkingOptionId: "medium" },
    ]);
    expect(snapshots.calls).toEqual([{ cwd: "/tmp/repo", wait: true }]);
  });
});
