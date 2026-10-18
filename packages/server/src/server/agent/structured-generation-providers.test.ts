import { describe, expect, test } from "vitest";

import { resolveStructuredGenerationProviders } from "./structured-generation-providers.js";
import type { ProviderSnapshotEntry } from "./agent-sdk-types.js";

const READY = "ready" as const;
const ERROR = "error" as const;

class WarnLog {
  readonly warnings: Array<{ obj: object; msg?: string }> = [];

  warn(obj: object, msg?: string) {
    this.warnings.push({ obj, msg });
  }
}

class ProviderSnapshots {
  readonly calls: Array<{ cwd?: string; wait?: boolean }> = [];

  constructor(private readonly entries: ProviderSnapshotEntry[]) {}

  async listProviders(input: { cwd?: string; wait?: boolean } = {}) {
    this.calls.push({ cwd: input.cwd, wait: input.wait });
    return this.entries;
  }
}

describe("resolveStructuredGenerationProviders", () => {
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

describe("resolveStructuredGenerationProviders with a custom source provider", () => {
  const builtinEntry: ProviderSnapshotEntry = {
    provider: "claude",
    status: READY,
    enabled: true,
    source: "builtin",
    models: [
      { provider: "claude", id: "claude-opus-5-5", label: "Opus 5.5", isDefault: true },
      { provider: "claude", id: "claude-haiku-4-5", label: "Haiku 4.5" },
    ],
  };
  const customEntry: ProviderSnapshotEntry = {
    provider: "claude-zdr",
    status: READY,
    enabled: true,
    source: "custom",
    models: [
      {
        provider: "claude-zdr",
        id: "claude-opus-5-5[1m]",
        label: "Opus 5.5 1M",
        isDefault: true,
      },
      { provider: "claude-zdr", id: "claude-haiku-5-5", label: "Haiku 5.5" },
    ],
  };
  const entries = [builtinEntry, customEntry];

  test("tries only the custom provider, its own Haiku before its default model", async () => {
    const providers = await resolveStructuredGenerationProviders({
      cwd: "/tmp/repo",
      providerSnapshotManager: new ProviderSnapshots(entries),
      sourceProviders: ["claude-zdr"],
    });

    expect(providers).toEqual([
      { provider: "claude-zdr", model: "claude-haiku-5-5" },
      { provider: "claude-zdr", model: "claude-opus-5-5[1m]" },
    ]);
  });

  test("keeps configured entries for the custom provider and drops the others", async () => {
    const providers = await resolveStructuredGenerationProviders({
      cwd: "/tmp/repo",
      providerSnapshotManager: new ProviderSnapshots(entries),
      daemonConfig: {
        metadataGeneration: {
          providers: [
            { provider: "claude", model: "claude-haiku-4-5" },
            { provider: "claude-zdr", model: "claude-haiku-5-5", thinkingOptionId: "low" },
          ],
        },
      },
      currentSelection: { provider: "claude", model: "claude-opus-5-5" },
      sourceProviders: ["claude-zdr"],
    });

    expect(providers).toEqual([
      { provider: "claude-zdr", model: "claude-haiku-5-5", thinkingOptionId: "low" },
      { provider: "claude-zdr", model: "claude-haiku-5-5" },
      { provider: "claude-zdr", model: "claude-opus-5-5[1m]" },
    ]);
  });

  test("uses the current selection when it is on the custom provider", async () => {
    const providers = await resolveStructuredGenerationProviders({
      cwd: "/tmp/repo",
      providerSnapshotManager: new ProviderSnapshots(entries),
      currentSelection: { provider: "claude-zdr", model: "claude-opus-5-5[1m]" },
      sourceProviders: ["claude-zdr"],
    });

    expect(providers).toEqual([
      { provider: "claude-zdr", model: "claude-haiku-5-5" },
      { provider: "claude-zdr", model: "claude-opus-5-5[1m]" },
    ]);
  });

  test("pins to the custom provider among built-in sources", async () => {
    const providers = await resolveStructuredGenerationProviders({
      cwd: "/tmp/repo",
      providerSnapshotManager: new ProviderSnapshots(entries),
      sourceProviders: [undefined, "claude", "claude-zdr", "claude-zdr"],
    });

    expect(providers.map((provider) => provider.provider)).toEqual(["claude-zdr", "claude-zdr"]);
  });

  test("offers nothing and logs both when the sources hold two custom providers", async () => {
    const workEntry: ProviderSnapshotEntry = {
      ...customEntry,
      provider: "claude-work",
      models: [{ provider: "claude-work", id: "claude-haiku-5-5", label: "Haiku 5.5" }],
    };
    const log = new WarnLog();
    const providers = await resolveStructuredGenerationProviders({
      cwd: "/tmp/repo",
      providerSnapshotManager: new ProviderSnapshots([...entries, workEntry]),
      currentSelection: { provider: "claude-zdr", model: "claude-opus-5-5[1m]" },
      sourceProviders: ["claude-zdr", "claude", "claude-work"],
      logger: log,
    });

    expect(providers).toEqual([]);
    expect(log.warnings).toEqual([
      {
        obj: { providers: ["claude-zdr", "claude-work"] },
        msg: "Structured generation skipped: agents on different custom providers",
      },
    ]);
  });

  test("offers nothing and logs the provider when the custom provider is disabled", async () => {
    const log = new WarnLog();
    const providers = await resolveStructuredGenerationProviders({
      cwd: "/tmp/repo",
      providerSnapshotManager: new ProviderSnapshots([
        builtinEntry,
        { ...customEntry, enabled: false },
      ]),
      sourceProviders: ["claude", "claude-zdr"],
      logger: log,
    });

    expect(providers).toEqual([]);
    expect(log.warnings).toEqual([
      {
        obj: { provider: "claude-zdr", reason: "disabled" },
        msg: "Structured generation skipped: custom provider unavailable",
      },
    ]);
  });

  test("offers nothing and logs the provider when it is gone from the config", async () => {
    const log = new WarnLog();
    const providers = await resolveStructuredGenerationProviders({
      cwd: "/tmp/repo",
      providerSnapshotManager: new ProviderSnapshots([builtinEntry]),
      sourceProviders: ["claude-zdr"],
      logger: log,
    });

    expect(providers).toEqual([]);
    expect(log.warnings).toEqual([
      {
        obj: { provider: "claude-zdr", reason: "not configured" },
        msg: "Structured generation skipped: custom provider unavailable",
      },
    ]);
  });

  test("a built-in source provider keeps the usual order", async () => {
    const providers = await resolveStructuredGenerationProviders({
      cwd: "/tmp/repo",
      providerSnapshotManager: new ProviderSnapshots(entries),
      sourceProviders: ["claude"],
    });

    expect(providers).toEqual([{ provider: "claude", model: "claude-haiku-4-5" }]);
  });
});
