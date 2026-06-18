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
  test("uses explicit configured provider models without refreshing provider snapshots", async () => {
    const snapshots = new ProviderSnapshots([]);

    const providers = await resolveStructuredGenerationProviders({
      cwd: "/tmp/repo",
      providerSnapshotManager: snapshots,
      daemonConfig: {
        metadataGeneration: {
          providers: [{ provider: "mock", model: "ten-second-stream" }],
        },
      },
    });

    expect(providers).toEqual([{ provider: "mock", model: "ten-second-stream" }]);
    expect(snapshots.calls).toEqual([]);
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
          { provider: "router", id: "minimax-m2.5-free", label: "MiniMax M2.5", isDefault: true },
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
      { provider: "router", model: "minimax-m2.5-free" },
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

  test("uses explicit configured provider models as-is instead of waiting to normalize aliases", async () => {
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

    expect(providers).toEqual([{ provider: "plexus", model: "small-fast" }]);
    expect(snapshots.calls).toEqual([]);
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

    expect(providers).toEqual([{ provider: "current-provider", model: "configured-model" }]);
    expect(snapshots.calls).toEqual([]);
  });
});
