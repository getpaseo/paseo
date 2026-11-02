/** @vitest-environment jsdom */
import React, { type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";

const { asyncStorage, runtime } = vi.hoisted(() => ({
  asyncStorage: new Map<string, string>(),
  runtime: {
    controlRequests: [] as unknown[],
    client: null as unknown,
  },
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => asyncStorage.get(key) ?? null,
    setItem: async (key: string, value: string) => void asyncStorage.set(key, value),
    removeItem: async (key: string) => void asyncStorage.delete(key),
  },
}));

const entries: ProviderSnapshotEntry[] = [
  {
    provider: "claude",
    status: "ready",
    enabled: true,
    modes: [{ id: "default", label: "Default" }],
    models: [{ provider: "claude", id: "sonnet", label: "Sonnet", isDefault: true }],
  },
  {
    provider: "codex",
    status: "ready",
    enabled: true,
    modes: [{ id: "auto", label: "Auto" }],
    models: [
      { provider: "codex", id: "gpt-5.4", label: "GPT-5.4", isDefault: true },
      { provider: "codex", id: "gpt-5.5", label: "GPT-5.5" },
    ],
  },
  // Ready, but it lists no models: the host cannot say which ids exist.
  {
    provider: "opencode",
    status: "ready",
    enabled: true,
    modes: [{ id: "build", label: "Build" }],
  },
];

vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({
    entries,
    isLoading: false,
    isFetching: false,
    isRefreshing: false,
    error: null,
    supportsSnapshot: true,
    refresh: async () => undefined,
    refetchIfStale: () => undefined,
  }),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => runtime.client,
  useHostRuntimeIsConnected: () => true,
}));

const { useAgentFormState } = await import("@/hooks/use-agent-form-state");
const { useDraftProviderOptions } = await import("@/hooks/use-draft-provider-options");
const { draftComposerAgent } = await import("./composer-agent");

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** The draft composer's hooks, joined the way the screens join them. */
const initialValues = { provider: "claude" } as const;

function useDraftComposer(context: "draft" | "new-workspace") {
  const form = useAgentFormState({
    serverId: "host-1",
    workingDir: "/repo",
    isVisible: true,
    initialValues,
  });
  const options = useDraftProviderOptions({
    serverId: "host-1",
    provider: form.selectedProvider,
    getProvider: form.getSelectedProvider,
    cwd: "/repo",
    modeId: form.selectedMode,
    modelId: form.selectedModel,
    thinkingOptionId: form.selectedThinkingOptionId,
  });
  const agent = draftComposerAgent({
    context,
    selectedProvider: form.selectedProvider,
    selectedModel: form.selectedModel,
    selectedMode: form.selectedMode,
    thinking: form.selectedThinkingOptionId || null,
    options: options.shownOptions,
    metadata: {},
    onSelectProviderAndModel: form.setProviderAndModelFromUser,
    onSelectModel: form.setModelFromUser,
    onSelectMode: form.setModeFromUser,
    onSelectThinkingOption: form.setThinkingOptionFromUser,
    onSetOption: options.setOption,
    onSetMetadata: () => undefined,
  });
  return { form, agent };
}

async function mount(context: "draft" | "new-workspace") {
  const view = renderHook(() => useDraftComposer(context), { wrapper });
  await waitFor(() => expect(view.result.current.form.selectedProvider).not.toBeNull());
  return view;
}

describe.each(["draft", "new-workspace"] as const)("the %s composer's agent", (context) => {
  beforeEach(() => {
    asyncStorage.clear();
    runtime.controlRequests = [];
    runtime.client = {
      listProviderControls: async (request: unknown) => {
        runtime.controlRequests.push(request);
        return { controls: [], options: {} };
      },
    };
  });

  it("applies each awaited command before the next one runs", async () => {
    const view = await mount(context);
    // A plugin keeps the object it was handed across its awaits.
    const retained = view.result.current.agent;
    const other = retained.provider === "codex" ? "claude" : "codex";
    const model = other === "codex" ? "gpt-5.5" : "sonnet";

    await act(async () => {
      await retained.setProvider(other);
      await retained.setModel(model);
      await retained.setOptions({ context: "1m" });
    });

    const { form, agent } = view.result.current;
    expect(agent.context).toBe(context);
    expect(form.selectedProvider).toBe(other);
    expect(form.selectedModel).toBe(model);
    expect(agent.options).toEqual({ context: "1m" });
    await waitFor(() =>
      expect(runtime.controlRequests.at(-1)).toMatchObject({
        provider: other,
        model,
        providerOptions: { context: "1m" },
      }),
    );
  });

  it("keeps the options of the provider they were set for", async () => {
    const view = await mount(context);
    const retained = view.result.current.agent;

    await act(async () => {
      await retained.setOptions({ context: "1m" });
      await retained.setProvider(retained.provider === "codex" ? "claude" : "codex");
    });

    // Choosing a provider by hand starts the options over.
    expect(view.result.current.agent.options).toEqual({});
  });

  it("rejects a provider the host cannot run and a model the catalog does not list", async () => {
    const view = await mount(context);
    const retained = view.result.current.agent;

    await act(async () => {
      await expect(retained.setProvider("nope")).rejects.toThrow(
        "Unknown or unavailable provider: nope",
      );
      await retained.setProvider("codex");
      await expect(retained.setModel("missing")).rejects.toThrow("Unknown model: missing");
    });
    expect(view.result.current.form.selectedProvider).toBe("codex");
    expect(view.result.current.form.selectedModel).not.toBe("missing");
  });

  it("keeps a model id as given when the provider lists no catalog", async () => {
    const view = await mount(context);
    const retained = view.result.current.agent;

    await act(async () => {
      await retained.setProvider("opencode");
      await retained.setModel("anthropic/claude-x");
    });
    expect(view.result.current.form.selectedModel).toBe("anthropic/claude-x");
  });
});
