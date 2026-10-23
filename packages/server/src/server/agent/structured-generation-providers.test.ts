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
  test("suggestion policy uses the per-kind chain while other manual metadata keeps the shared chain", async () => {
    const snapshots = new ProviderSnapshots([
      {
        provider: "codex",
        status: READY,
        enabled: true,
        models: [
          { provider: "codex", id: "gpt-6-astra", label: "Astra" },
          { provider: "codex", id: "gpt-5.4-mini", label: "Mini" },
        ],
      },
    ]);
    const common = {
      cwd: "/tmp/repo",
      providerSnapshotManager: snapshots,
      daemonConfig: {
        metadataGeneration: {
          providers: [{ provider: "codex", model: "shared" }],
          promptSuggestions: { providers: [{ provider: "codex", model: "cheap" }] },
        },
      },
      currentSelection: { provider: "codex", model: "gpt-6-astra" },
    };

    const suggestions = await resolveStructuredGenerationProviders({
      ...common,
      configKey: "promptSuggestions",
      selectionPolicy: "configured-only",
    });
    const commitMessage = await resolveStructuredGenerationProviders({
      ...common,
      configKey: "commitMessage",
    });

    expect(suggestions).toEqual([{ provider: "codex", model: "cheap" }]);
    expect(commitMessage).toEqual([{ provider: "codex", model: "shared" }]);
  });

  test("suggestion policy uses the shared chain when its per-kind list is empty", async () => {
    const providers = await resolveStructuredGenerationProviders({
      cwd: "/tmp/repo",
      providerSnapshotManager: new ProviderSnapshots([
        {
          provider: "claude",
          status: READY,
          enabled: true,
          models: [{ provider: "claude", id: "haiku", label: "Haiku" }],
        },
      ]),
      daemonConfig: {
        metadataGeneration: {
          providers: [{ provider: "codex", model: "shared" }],
          newChatSuggestions: { providers: [] },
        },
      },
      configKey: "newChatSuggestions",
      selectionPolicy: "configured-only",
    });

    expect(providers).toEqual([{ provider: "codex", model: "shared" }]);
  });

  test("suggestion policy leaves an empty chain empty even when defaults are available", async () => {
    const providers = await resolveStructuredGenerationProviders({
      cwd: "/tmp/repo",
      providerSnapshotManager: new ProviderSnapshots([
        {
          provider: "claude",
          status: READY,
          enabled: true,
          models: [{ provider: "claude", id: "haiku", label: "Haiku" }],
        },
      ]),
      configKey: "newChatSuggestions",
      selectionPolicy: "configured-only",
      currentSelection: { provider: "codex", model: "gpt-6-astra" },
    });

    expect(providers).toEqual([]);
  });

  test("tries only the configured models when metadata generation is manual", async () => {
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
        provider: "opencode",
        status: READY,
        enabled: true,
        models: [{ provider: "opencode", id: "minimax-m3", label: "MiniMax M3", isDefault: true }],
      },
    ]);

    const providers = await resolveStructuredGenerationProviders({
      cwd: "/tmp/repo",
      providerSnapshotManager: snapshots,
      daemonConfig: {
        metadataGeneration: {
          providers: [
            { provider: "local-llm", model: "qwen-local" },
            { provider: "mock", model: "ten-second-stream" },
          ],
        },
      },
      currentSelection: { provider: "opencode", model: "minimax-m3" },
    });

    expect(providers).toEqual([
      { provider: "local-llm", model: "qwen-local" },
      { provider: "mock", model: "ten-second-stream" },
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

  test("prefers the providers configured for this metadata kind", async () => {
    const snapshots = new ProviderSnapshots([
      { provider: "current-provider", status: ERROR, enabled: true, error: "timed out" },
    ]);

    const providers = await resolveStructuredGenerationProviders({
      cwd: "/tmp/repo",
      providerSnapshotManager: snapshots,
      daemonConfig: {
        metadataGeneration: {
          providers: [{ provider: "current-provider", model: "shared-model" }],
          promptSuggestions: {
            providers: [{ provider: "current-provider", model: "cheap-model" }],
          },
        },
      },
      configKey: "promptSuggestions",
    });

    expect(providers).toEqual([{ provider: "current-provider", model: "cheap-model" }]);
  });

  test("falls back to the shared providers for a kind that configures none", async () => {
    const snapshots = new ProviderSnapshots([
      { provider: "current-provider", status: ERROR, enabled: true, error: "timed out" },
    ]);

    const providers = await resolveStructuredGenerationProviders({
      cwd: "/tmp/repo",
      providerSnapshotManager: snapshots,
      daemonConfig: {
        metadataGeneration: {
          providers: [{ provider: "current-provider", model: "shared-model" }],
          promptSuggestions: {
            providers: [{ provider: "current-provider", model: "cheap-model" }],
          },
        },
      },
      configKey: "commitMessage",
    });

    expect(providers).toEqual([{ provider: "current-provider", model: "shared-model" }]);
  });

  test("takes the first of several kinds that configures providers", async () => {
    const snapshots = new ProviderSnapshots([
      { provider: "current-provider", status: ERROR, enabled: true, error: "timed out" },
    ]);

    const providers = await resolveStructuredGenerationProviders({
      cwd: "/tmp/repo",
      providerSnapshotManager: snapshots,
      daemonConfig: {
        metadataGeneration: {
          providers: [{ provider: "current-provider", model: "shared-model" }],
          branchName: { providers: [{ provider: "current-provider", model: "slug-model" }] },
        },
      },
      configKey: ["title", "branchName"],
    });

    expect(providers).toEqual([{ provider: "current-provider", model: "slug-model" }]);
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
    expect(snapshots.calls).toEqual([{ cwd: "/tmp/repo", wait: true }]);
  });
});
