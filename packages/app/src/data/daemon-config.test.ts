import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { MutableDaemonConfig, MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";
import {
  daemonConfigQueryOptions,
  daemonConfigLoadState,
  patchDaemonConfig,
  type DaemonConfigClient,
} from "./daemon-config";
import {
  isModelVisibilitySupported,
  resolveVisibilityStatus,
  buildModelVisibilityByProvider,
  retryModelSelection,
  setModelVisible,
} from "@/provider-selection/model-visibility";
import { openAgentProfileForm } from "@/agent-profiles/internal/profile-form-model";

function configAdapter() {
  const config: MutableDaemonConfig = {
    relay: { enabled: false },
    mcp: { injectIntoAgents: false },
    browserTools: { enabled: false },
    providers: { claude: { modelVisibility: { hidden: false } } },
    metadataGeneration: { providers: [] },
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    appendSystemPrompt: "",
  };
  const patches: MutableDaemonConfigPatch[] = [];
  let failure: Error | null = null;
  let reads = 0;
  const client: DaemonConfigClient = {
    async getDaemonConfig() {
      reads++;
      if (failure) throw failure;
      return { config };
    },
    async patchDaemonConfig(patch) {
      if (failure) throw failure;
      patches.push(patch);
      return { config };
    },
  };
  return {
    client,
    config,
    patches,
    reads: () => reads,
    fail: () => {
      failure = new Error("Disconnected");
    },
    recover: () => {
      failure = null;
    },
  };
}

function observeConfig(adapter: ReturnType<typeof configAdapter>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const observer = new QueryObserver(queryClient, {
    ...daemonConfigQueryOptions("host", adapter.client, "Disconnected"),
    enabled: false,
  });
  return { observer, queryClient };
}

describe("daemon config consumers", () => {
  it("retries a cold failure for metadata settings and the profile model catalog", async () => {
    const adapter = configAdapter();
    adapter.fail();
    const { observer, queryClient } = observeConfig(adapter);
    const model = openAgentProfileForm({ mode: "create" });
    model.applyProviderCatalog([
      {
        provider: "claude",
        status: "ready",
        enabled: true,
        label: "Claude",
        defaultModeId: "plan",
        modes: [{ id: "plan", label: "Plan" }],
        models: [
          { provider: "claude", id: "hidden", label: "Hidden", isDefault: true },
          { provider: "claude", id: "visible", label: "Visible" },
        ],
      },
    ]);
    model.setProvider("claude", { label: "Claude" });
    const failed = await observer.refetch();
    const status = resolveVisibilityStatus({
      isSupported: true,
      hasConfig: failed.data !== undefined,
      isError: failed.isError,
    });
    expect(daemonConfigLoadState(failed.data ?? null, failed.isError)).toBe("error");
    expect(status).toBe("error");
    model.applyModelVisibility({ status, visibilityByProvider: undefined });
    expect(model.getState().modelOptionsState).toBe("error");
    expect(model.getState().modelOptions).toEqual([]);
    expect(model.getState().modelId).toBe("");
    expect(model.getState().canSubmit).toBe(false);
    adapter.recover();
    let refreshes = 0;
    let retry = Promise.resolve(failed);
    retryModelSelection({
      status,
      retryVisibility: () => {
        retry = observer.refetch();
      },
      refreshDiscovery: () => {
        refreshes++;
      },
    });
    const recovered = await retry;
    expect(adapter.reads()).toBe(2);
    expect(refreshes).toBe(1);
    expect(daemonConfigLoadState(recovered.data ?? null, recovered.isError)).toBe("ready");
    const ready = resolveVisibilityStatus({
      isSupported: true,
      hasConfig: recovered.data !== undefined,
      isError: recovered.isError,
    });
    expect(ready).toBe("ready");
    model.applyModelVisibility({
      status: ready,
      visibilityByProvider: buildModelVisibilityByProvider(recovered.data?.providers),
    });
    expect(model.getState().modelOptionsState).toBe("ready");
    expect(model.getState().modelId).toBe("visible");
    model.close();
    observer.destroy();
    queryClient.clear();
  });

  it("keeps acknowledged visibility and metadata settings after a failed refresh", async () => {
    const adapter = configAdapter();
    const { observer, queryClient } = observeConfig(adapter);
    await observer.refetch();
    adapter.fail();
    const result = await observer.refetch();
    expect(result.isError).toBe(true);
    expect(adapter.reads()).toBe(2);
    expect(result.data).toEqual(adapter.config);
    expect(daemonConfigLoadState(result.data ?? null, result.isError)).toBe("ready");
    expect(
      resolveVisibilityStatus({
        isSupported: true,
        hasConfig: result.data !== undefined,
        isError: result.isError,
      }),
    ).toBe("ready");
    expect(buildModelVisibilityByProvider(result.data?.providers)).toEqual({
      claude: { hidden: false },
    });
    observer.destroy();
    queryClient.clear();
  });

  it("reports a disconnected save and patches only the requested model on recovery", async () => {
    const adapter = configAdapter();
    const queryClient = new QueryClient();
    const input = {
      provider: "claude",
      modelId: "visible",
      visible: false,
      disconnectedMessage: "Disconnected",
    };
    await expect(
      setModelVisible({
        ...input,
        patchConfig: (patch) =>
          patchDaemonConfig({ serverId: "host", client: null, queryClient, patch }),
      }),
    ).rejects.toThrow("Disconnected");
    expect(adapter.patches).toEqual([]);
    await setModelVisible({
      ...input,
      patchConfig: (patch) =>
        patchDaemonConfig({ serverId: "host", client: adapter.client, queryClient, patch }),
    });
    expect(adapter.patches).toEqual([
      { providers: { claude: { modelVisibility: { visible: false } } } },
    ]);
    expect(queryClient.getQueryData(["daemon-config", "host"])).toEqual(adapter.config);
    queryClient.clear();
  });

  it.each([
    [{ features: {}, permissions: ["daemon.read"] }, false],
    [{ features: { modelVisibility: true }, permissions: ["workspace.read"] }, false],
    [{ features: { modelVisibility: true } }, true],
    [{ features: { modelVisibility: true }, permissions: ["daemon.read"] }, true],
  ] as const)("gates the preference on capability and read permission: %j", (info, supported) => {
    expect(isModelVisibilitySupported(info)).toBe(supported);
    expect(
      resolveVisibilityStatus({ isSupported: supported, hasConfig: true, isError: false }),
    ).toBe(supported ? "ready" : "unavailable");
  });

  it.each(["ready", "loading", "unavailable"] as const)(
    "retries only discovery when visibility is %s",
    (status) => {
      const calls: string[] = [];
      retryModelSelection({
        status,
        retryVisibility: () => {
          calls.push("config");
        },
        refreshDiscovery: () => {
          calls.push("discovery");
        },
      });
      expect(calls).toEqual(["discovery"]);
    },
  );

  it("reports loading before the first config arrives", () => {
    expect(daemonConfigLoadState(null, false)).toBe("loading");
    expect(resolveVisibilityStatus({ isSupported: true, hasConfig: false, isError: false })).toBe(
      "loading",
    );
  });
});
