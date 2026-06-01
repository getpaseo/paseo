import { describe, expect, test, vi } from "vitest";

import { resolveStructuredGenerationProviders } from "./structured-generation-providers.js";

const READY = "ready" as const;
const ERROR = "error" as const;

describe("resolveStructuredGenerationProviders", () => {
  test("prefers configured providers, resolves dynamic defaults, and dedupes duplicates", async () => {
    const listProviders = vi.fn(async () => [
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
      providerSnapshotManager: { listProviders },
      daemonConfig: {
        metadataGeneration: {
          providers: [
            { provider: "stale-codex", model: "missing-model", thinkingOptionId: "low" },
            { provider: "work-claude" },
          ],
        },
      },
      currentSelection: {
        provider: "focused-provider",
        model: "focused-model",
        thinkingOptionId: "high",
      },
    });

    expect(providers).toEqual([
      { provider: "stale-codex", model: "missing-model", thinkingOptionId: "low" },
      { provider: "work-claude", model: "claude-haiku-2026" },
      { provider: "work-codex", model: "gpt-5.4-mini-2026", thinkingOptionId: "low" },
      { provider: "router", model: "minimax-m2.5-free" },
      { provider: "router", model: "nemotron-3-super-free" },
      { provider: "focused-provider", model: "focused-model", thinkingOptionId: "high" },
    ]);
    expect(listProviders).toHaveBeenCalledWith({ cwd: "/tmp/repo", wait: true });
  });

  test("falls back to the current selection when defaults do not match", async () => {
    const providers = await resolveStructuredGenerationProviders({
      cwd: "/tmp/repo",
      providerSnapshotManager: {
        listProviders: vi.fn(async () => [
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
        ]),
      },
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
    const providers = await resolveStructuredGenerationProviders({
      cwd: "/tmp/repo",
      providerSnapshotManager: {
        listProviders: vi.fn(async () => [
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
        ]),
      },
      currentSelection: { provider: "focused-provider" },
    });

    expect(providers).toEqual([
      { provider: "focused-provider", model: "focused-default", thinkingOptionId: "balanced" },
    ]);
  });

  test("normalizes nested OpenCode provider entries to the top-level provider and full model id", async () => {
    const providers = await resolveStructuredGenerationProviders({
      cwd: "/tmp/repo",
      providerSnapshotManager: {
        listProviders: vi.fn(async () => [
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
        ]),
      },
      daemonConfig: {
        metadataGeneration: {
          providers: [{ provider: "plexus", model: "small-fast" }],
        },
      },
    });

    expect(providers).toEqual([{ provider: "opencode", model: "plexus/small-fast" }]);
  });

  test("keeps explicit candidates when provider snapshots are in error state", async () => {
    const providers = await resolveStructuredGenerationProviders({
      cwd: "/tmp/repo",
      providerSnapshotManager: {
        listProviders: vi.fn(async () => [
          {
            provider: "current-provider",
            status: ERROR,
            enabled: true,
            error: "timed out",
          },
        ]),
      },
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
  });
});
