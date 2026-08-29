/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { FormPreferences } from "./use-form-preferences";

// The hook reads the provider snapshot, form preferences, and host list through
// these three hooks; drive them directly so the loading→ready transition is
// deterministic rather than dependent on react-query and the daemon.
const snapshot: { entries: ProviderSnapshotEntry[] | undefined } = { entries: undefined };
const preferences: { value: FormPreferences } = { value: {} };

vi.mock("./use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({
    entries: snapshot.entries,
    isLoading: snapshot.entries === undefined,
    isRefreshing: false,
    error: null,
    refresh: vi.fn(async () => {}),
    refetchIfStale: vi.fn(),
  }),
}));

vi.mock("./use-form-preferences", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./use-form-preferences")>();
  return {
    ...actual,
    useFormPreferences: () => ({
      preferences: preferences.value,
      isLoading: false,
      updatePreferences: vi.fn(async () => preferences.value),
    }),
  };
});

vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => [{ serverId: "s1" }],
}));

import { useAgentFormState } from "./use-agent-form-state";

const KIRO_MODEL = {
  provider: "kiro",
  id: "claude-opus-4.8",
  label: "Claude Opus 4.8",
  isDefault: true,
};

function kiroEntry(status: ProviderSnapshotEntry["status"]): ProviderSnapshotEntry {
  return {
    provider: "kiro",
    status,
    enabled: true,
    label: "Kiro",
    description: "",
    defaultModeId: "",
    modes: [],
    ...(status === "ready" ? { models: [KIRO_MODEL] } : {}),
  };
}

function renderFormState() {
  return renderHook(() =>
    useAgentFormState({
      initialServerId: "s1",
      initialValues: { serverId: "s1", workingDir: "/repo" },
      isVisible: true,
      isCreateFlow: true,
    }),
  );
}

describe("useAgentFormState — slow-probing provider", () => {
  beforeEach(() => {
    snapshot.entries = undefined;
    preferences.value = {};
  });

  it("commits a provider picked while it is still probing (loading)", () => {
    snapshot.entries = [kiroEntry("loading")];
    const { result } = renderFormState();

    act(() => {
      result.current.setProviderAndModelFromUser("kiro", "");
    });

    expect(result.current.selectedProvider).toBe("kiro");
  });

  it("backfills the default model once the committed provider reaches ready", () => {
    snapshot.entries = [kiroEntry("loading")];
    const { result, rerender } = renderFormState();

    act(() => {
      result.current.setProviderAndModelFromUser("kiro", "");
    });
    expect(result.current.selectedProvider).toBe("kiro");
    expect(result.current.selectedModel).toBe("");

    snapshot.entries = [kiroEntry("ready")];
    rerender();

    expect(result.current.selectedProvider).toBe("kiro");
    expect(result.current.selectedModel).toBe("claude-opus-4.8");
  });

  it("auto-resolves a remembered probing provider and backfills on ready", () => {
    preferences.value = { provider: "kiro" };
    snapshot.entries = [kiroEntry("loading")];
    const { result, rerender } = renderFormState();

    expect(result.current.selectedProvider).toBe("kiro");

    snapshot.entries = [kiroEntry("ready")];
    rerender();

    expect(result.current.selectedModel).toBe("claude-opus-4.8");
  });
});
