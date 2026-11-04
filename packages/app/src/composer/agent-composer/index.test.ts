import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { resolveAgentModelSelection } from "@/composer/agent-controls/utils";
import { filterSelectableModels } from "@/provider-selection/model-catalog";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { createAgentComposer } from "./index";

const serverId = "host-1";
const agentId = "agent-1";
const draftKey = buildDraftStoreKey({ serverId, agentId });

const entries: ProviderSnapshotEntry[] = [
  {
    provider: "claude",
    status: "ready",
    enabled: true,
    models: [
      {
        provider: "claude",
        id: "opus",
        label: "Opus",
        isDefault: true,
        defaultThinkingOptionId: "high",
        thinkingOptions: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ],
      },
      {
        provider: "claude",
        id: "claude-sonnet-4",
        label: "Sonnet 4",
        aliases: ["sonnet"],
        thinkingOptions: [{ id: "low", label: "Low" }],
      },
    ],
  },
];

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    serverId,
    id: agentId,
    provider: "claude",
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    createdAt: new Date("2026-11-04T10:00:00.000Z"),
    updatedAt: new Date("2026-11-04T10:00:00.000Z"),
    lastUserMessageAt: null,
    lastActivityAt: new Date("2026-11-04T10:00:00.000Z"),
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: "default",
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
    cwd: "/repo",
    workspaceId: "workspace-1",
    model: null,
    parentAgentId: null,
    labels: {},
    ...overrides,
  };
}

function fakeClient() {
  const calls: string[] = [];
  const client = {
    async getProvidersSnapshot() {
      return { entries, generatedAt: "2026-11-04T10:00:00.000Z", requestId: "snapshot" };
    },
    async setAgentModel(id: string, model: string | null) {
      calls.push(`model:${id}:${model}`);
      if (model === "nope") throw new Error("Model 'nope' is not available for provider 'claude'");
    },
    async setAgentMetadata(id: string, patch: unknown) {
      calls.push(`metadata:${id}:${JSON.stringify(patch)}`);
    },
    async setAgentOptions(id: string, patch: unknown) {
      calls.push(`options:${id}:${JSON.stringify(patch)}`);
    },
    async setAgentMode(id: string, mode: string) {
      calls.push(`mode:${id}:${mode}`);
      return null;
    },
    async setAgentThinkingOption(id: string, thinking: string) {
      calls.push(`thinking:${id}:${thinking}`);
      return null;
    },
  };
  return { client: client as unknown as DaemonClient, calls };
}

function openSession(running: Agent) {
  const { client, calls } = fakeClient();
  const store = useSessionStore.getState();
  store.initializeSession(serverId, client);
  store.updateSessionServerInfo(serverId, {
    serverId,
    hostname: null,
    version: null,
    features: { providersSnapshot: true },
  } as never);
  store.setAgents(serverId, new Map([[running.id, running]]));
  return calls;
}

async function until(read: () => unknown, expected: unknown) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (Object.is(read(), expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(read()).toBe(expected);
}

function composer() {
  return createAgentComposer(serverId, agentId, { queryClient: new QueryClient() });
}

beforeEach(() => {
  useDraftStore.setState({ drafts: {} });
});

afterEach(() => {
  useSessionStore.getState().clearSession(serverId);
});

describe("agent composer", () => {
  it("keeps the prompt in the stored draft while no composer is mounted", () => {
    openSession(agent());
    const model = composer();
    model.insertText("Review ");
    model.insertText("this diff.\n");
    expect(model.getState().prompt).toBe("Review this diff.\n");
    expect(useDraftStore.getState().getDraftInput(draftKey)?.text).toBe("Review this diff.\n");
    model.setPrompt("Start over");
    expect(model.getState().prompt).toBe("Start over");
  });

  it("sends prompt commands through the mounted composer while it is mounted", () => {
    openSession(agent());
    const model = composer();
    const mounted: string[] = [];
    const detach = model.attachInput({
      setText: (text) => mounted.push(`set:${text}`),
      insertText: (text) => mounted.push(`insert:${text}`),
    });
    model.insertText("at the cursor");
    model.setPrompt("replaced");
    expect(mounted).toEqual(["insert:at the cursor", "set:replaced"]);
    expect(useDraftStore.getState().getDraftInput(draftKey)).toBeUndefined();
    detach();
    model.insertText("stored");
    expect(model.getState().prompt).toBe("stored");
  });

  it("notifies subscribers of a stored prompt and returns the same state until something changes", () => {
    openSession(agent());
    const model = composer();
    let notified = 0;
    const stop = model.subscribe(() => {
      notified += 1;
    });
    const before = model.getState();
    expect(model.getState()).toBe(before);
    model.insertText("x");
    expect(notified).toBeGreaterThan(0);
    expect(model.getState()).not.toBe(before);
    stop();
  });

  it("adds and removes attachments in the stored draft", () => {
    openSession(agent());
    const model = composer();
    const attachment = {
      kind: "plugin_resource" as const,
      pluginId: "review",
      sourceId: "issues",
      sourceTitle: "Issues",
      sourceIcon: "CircleDot",
      item: {
        id: "1",
        identifier: "ENG-1",
        title: "Title",
        subtitle: "Open",
        url: "https://example.com/1",
        text: "Issue ENG-1: Title",
        resourceType: "issue",
      },
    };
    model.changeAttachments((current) => [...current, attachment]);
    expect(model.getState().attachments).toHaveLength(1);
    model.changeAttachments(() => []);
    expect(model.getState().attachments).toHaveLength(0);
  });

  it("reads mode, options and metadata from the agent, and sends commands to the daemon", async () => {
    const calls = openSession(
      agent({ currentModeId: "plan", options: { effort: "high" }, metadata: { flag: true } }),
    );
    const model = composer();
    expect(model.getState()).toMatchObject({
      context: "agent",
      provider: "claude",
      mode: "plan",
      options: { effort: "high" },
      metadata: { flag: true },
    });
    await model.setMetadata({ flag: null });
    await model.setOptions({ effort: "low" });
    await model.setMode("default");
    expect(calls).toEqual([
      'metadata:agent-1:{"flag":null}',
      'options:agent-1:{"effort":"low"}',
      "mode:agent-1:default",
    ]);
    await expect(model.setProvider("codex")).rejects.toThrow(
      "A running agent cannot change provider.",
    );
  });

  it("rejects an unlisted model with the daemon's message", async () => {
    openSession(agent());
    await expect(composer().setModel("nope")).rejects.toThrow(
      "Model 'nope' is not available for provider 'claude'",
    );
  });

  it.each([
    ["an alias of a listed model", { runtimeInfo: { model: "sonnet" } }, "claude-sonnet-4", "low"],
    ["no reported model", { model: null }, "opus", "high"],
    ["the configured model", { model: "opus", thinkingOptionId: "low" }, "opus", "low"],
  ] as const)(
    "reads the model and thinking the picker shows for %s, once the catalog loads",
    async (_name, overrides, expectedModel, expectedThinking) => {
      const running = agent(overrides as unknown as Partial<Agent>);
      openSession(running);
      const model = composer();
      expect(model.getState()).toMatchObject({ model: null, thinking: null });
      const stop = model.subscribe(() => {});
      await until(() => model.getState().model, expectedModel);
      const picker = resolveAgentModelSelection({
        models: filterSelectableModels(entries[0]?.models ?? null),
        runtimeModelId: running.runtimeInfo?.model ?? null,
        configuredModelId: running.model,
        runtimeThinkingOptionId: running.runtimeInfo?.thinkingOptionId ?? null,
        explicitThinkingOptionId: running.thinkingOptionId,
      });
      expect(model.getState()).toMatchObject({
        model: picker.activeModelId,
        thinking: picker.selectedThinkingId,
      });
      expect(model.getState().thinking).toBe(expectedThinking);
      stop();
    },
  );
});
