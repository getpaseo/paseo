/**
 * @vitest-environment jsdom
 */
import React, { useImperativeHandle } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonClient } from "@server/client/daemon-client";
import { PaneFocusProvider, PaneProvider, type PaneFocusContextValue } from "@/panels/pane-context";
import { agentPanelRegistration } from "@/panels/agent-panel";
import { useDraftStore } from "@/stores/draft-store";
import { useSessionStore, type Agent } from "@/stores/session-store";
import type { PendingPermission } from "@/types/shared";
import type { StreamItem } from "@/types/stream";
import type { AgentPermissionRequest } from "@server/server/agent/agent-sdk-types";

type PanelTestTheme = {
  colors: {
    foreground: string;
    foregroundMuted: string;
    surface0: string;
    surface1: string;
    surface2: string;
    surface3: string;
    border: string;
    destructive: string;
  };
  spacing: Record<number, number>;
  borderRadius: Record<string, number>;
  fontSize: Record<string, number>;
  fontWeight: Record<string, string>;
  iconSize: Record<string, number>;
};
type PanelTestStyles = Record<string, unknown>;
type PanelTestStyleFactory = (input: PanelTestTheme) => PanelTestStyles;

const {
  composerRenderCount,
  composerUnmountCount,
  latestComposerCwd,
  latestComposerIsPaneFocused,
  streamRenderCount,
  latestStreamPermissionKeys,
  latestStreamText,
  theme,
  runtimeClient,
} = vi.hoisted(() => {
  Object.defineProperty(globalThis, "__DEV__", {
    value: false,
    configurable: true,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    value: true,
    configurable: true,
  });
  Object.defineProperty(globalThis, "ResizeObserver", {
    value: class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    configurable: true,
  });

  return {
    composerRenderCount: vi.fn(),
    composerUnmountCount: vi.fn(),
    latestComposerCwd: { current: null as string | null },
    latestComposerIsPaneFocused: { current: null as boolean | null },
    streamRenderCount: vi.fn(),
    latestStreamPermissionKeys: { current: [] as string[] },
    latestStreamText: { current: null as string | null },
    theme: {
      colors: {
        foreground: "#ffffff",
        foregroundMuted: "#999999",
        surface0: "#000000",
        surface1: "#111111",
        surface2: "#222222",
        surface3: "#333333",
        border: "#444444",
        destructive: "#ff0000",
      },
      spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
      borderRadius: { md: 6, lg: 8, xl: 12 },
      fontSize: { sm: 13, base: 15, lg: 18 },
      fontWeight: { medium: "500" },
      iconSize: { lg: 22 },
    } satisfies PanelTestTheme,
    runtimeClient: {
      fetchAgent: vi.fn(),
      fetchAgentTimeline: vi.fn(),
    },
  };
});

vi.mock("react-native-reanimated", () => ({
  default: {
    View: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  },
}));

vi.mock("react-native-unistyles", () => {
  return {
    StyleSheet: {
      create: createPanelTestStyles,
    },
    useUnistyles: () => ({ theme }),
  };
});

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

function createPanelTestStyles(factory: PanelTestStyleFactory | PanelTestStyles): PanelTestStyles {
  return typeof factory === "function" ? factory(theme) : factory;
}

vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => [{ serverId: "server", label: "Test server" }],
  useHostRuntimeClient: () => runtimeClient,
  useHostRuntimeIsConnected: () => false,
  useHostRuntimeConnectionStatus: () => "offline",
  useHostRuntimeLastError: () => null,
}));

vi.mock("@/attachments/service", () => ({
  garbageCollectAttachments: vi.fn(async () => {}),
  persistAttachmentFromDataUrl: vi.fn(),
  persistAttachmentFromFileUri: vi.fn(),
}));

vi.mock("@/components/provider-icons", () => ({
  getProviderIcon: () => null,
}));

vi.mock("@/components/file-drop-zone", () => ({
  FileDropZone: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/toast-host", () => ({
  ToastViewport: () => null,
  useToastHost: () => ({
    toast: null,
    dismiss: vi.fn(),
    api: {
      show: vi.fn(),
    },
  }),
}));

vi.mock("@/components/archived-agent-callout", () => ({
  ArchivedAgentCallout: ({ agentId }: { agentId: string }) => (
    <div data-testid="archived-agent-callout">{agentId}</div>
  ),
}));

vi.mock("@/hooks/use-keyboard-shift-style", () => ({
  useKeyboardShiftStyle: () => ({ style: null }),
}));

vi.mock("@/hooks/use-archive-agent", () => ({
  useArchiveAgent: () => ({
    isArchivingAgent: () => false,
  }),
}));

vi.mock("@/components/composer", () => ({
  Composer: ({ cwd, isPaneFocused }: { cwd: string; isPaneFocused: boolean }) => {
    React.useEffect(
      () => () => {
        composerUnmountCount();
      },
      [],
    );
    composerRenderCount();
    latestComposerCwd.current = cwd;
    latestComposerIsPaneFocused.current = isPaneFocused;
    return <div data-testid="composer">{cwd}</div>;
  },
}));

vi.mock("@/components/agent-stream-view", () => ({
  AgentStreamView: React.memo(
    React.forwardRef<
      { prepareForViewportChange: () => void; scrollToBottom: (reason: "message-sent") => void },
      { pendingPermissions: Map<string, PendingPermission>; streamItems: StreamItem[] }
    >(function AgentStreamView({ pendingPermissions, streamItems }, ref) {
      useImperativeHandle(ref, () => ({
        prepareForViewportChange: vi.fn(),
        scrollToBottom: vi.fn(),
      }));
      streamRenderCount();
      latestStreamPermissionKeys.current = Array.from(pendingPermissions.keys());
      latestStreamText.current =
        streamItems.find((item) => item.kind === "user_message")?.text ?? null;
      return <div data-testid="agent-stream-view">{latestStreamText.current}</div>;
    }),
  ),
}));

function makeClient(): DaemonClient {
  return new DaemonClient({
    url: "ws://127.0.0.1:1",
    clientId: "panel-render-isolation-test",
  });
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  const now = new Date("2026-04-20T00:00:00.000Z");
  return {
    serverId: "server",
    id: "agent",
    provider: "codex",
    status: "running",
    createdAt: now,
    updatedAt: now,
    lastUserMessageAt: null,
    lastActivityAt: now,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    lastError: null,
    title: "Render isolation",
    cwd: "/workspace/one",
    model: null,
    labels: {},
    ...overrides,
  };
}

function seedReadyAgent(agent: Agent = makeAgent()) {
  const store = useSessionStore.getState();
  store.initializeSession("server", makeClient());
  store.setAgents("server", new Map([["agent", agent]]));
  store.setAgentAuthoritativeHistoryApplied("server", "agent", true);
}

async function renderAgentPanel(
  root: Root,
  focus: PaneFocusContextValue = {
    isWorkspaceFocused: true,
    isPaneFocused: false,
    isInteractive: false,
  },
) {
  const AgentPanel = agentPanelRegistration.component;
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <PaneProvider
          value={{
            serverId: "server",
            workspaceId: "workspace",
            tabId: "agent-agent",
            target: { kind: "agent", agentId: "agent" },
            openTab: vi.fn(),
            closeCurrentTab: vi.fn(),
            retargetCurrentTab: vi.fn(),
            openFileInWorkspace: vi.fn(),
          }}
        >
          <PaneFocusProvider value={focus}>
            <AgentPanel />
          </PaneFocusProvider>
        </PaneProvider>
      </QueryClientProvider>,
    );
    await Promise.resolve();
  });
}

function updateCurrentAgentStream(text: string) {
  act(() => {
    useSessionStore.getState().setAgentStreamTail("server", (previous) => {
      const next = new Map(previous);
      next.set("agent", [
        {
          kind: "user_message",
          id: `message-${text}`,
          text,
          timestamp: new Date("2026-04-20T00:00:01.000Z"),
        },
      ]);
      return next;
    });
  });
}

function makePendingPermission(agentId: string, requestId: string): PendingPermission {
  const request: AgentPermissionRequest = {
    id: requestId,
    provider: "codex",
    name: `permission-${requestId}`,
    kind: "tool",
  };
  const key = `${agentId}:${requestId}`;
  return {
    key,
    agentId,
    request,
  };
}

function updatePendingPermissions(permissions: PendingPermission[]) {
  act(() => {
    useSessionStore
      .getState()
      .setPendingPermissions(
        "server",
        new Map(permissions.map((permission) => [permission.key, permission])),
      );
  });
}

async function updateCurrentAgentCwd(cwd: string) {
  await act(async () => {
    useSessionStore.getState().setAgents("server", (previous) => {
      const current = previous.get("agent");
      if (!current) {
        throw new Error("Expected seeded agent");
      }
      const next = new Map(previous);
      next.set("agent", { ...current, cwd });
      return next;
    });
    await Promise.resolve();
  });
}

describe("AgentPanel render isolation", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    root = null;
    container?.remove();
    container = null;
    useSessionStore.setState({ sessions: {}, agentLastActivity: new Map() });
    useDraftStore.setState({ drafts: {}, createModalDraft: null });
    composerRenderCount.mockClear();
    composerUnmountCount.mockClear();
    latestComposerCwd.current = null;
    latestComposerIsPaneFocused.current = null;
    streamRenderCount.mockClear();
    latestStreamPermissionKeys.current = [];
    latestStreamText.current = null;
  });

  it("refreshes the stream view without invoking Composer for stream-only updates", async () => {
    seedReadyAgent();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await renderAgentPanel(root);
    const composerBaseline = composerRenderCount.mock.calls.length;
    const streamBaseline = streamRenderCount.mock.calls.length;
    expect(composerBaseline).toBeGreaterThan(0);
    expect(streamBaseline).toBeGreaterThan(0);

    updateCurrentAgentStream("stream-only update");

    expect(latestStreamText.current).toBe("stream-only update");
    expect(streamRenderCount).toHaveBeenCalledTimes(streamBaseline + 1);
    expect(composerRenderCount).toHaveBeenCalledTimes(composerBaseline);
  });

  it("does not advertise the composer as focused when its workspace is hidden", async () => {
    seedReadyAgent();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await renderAgentPanel(root, {
      isWorkspaceFocused: false,
      isPaneFocused: true,
      isInteractive: false,
    });

    expect(latestComposerIsPaneFocused.current).toBe(false);
  });

  it("still invokes Composer for current-agent cwd changes and unmounts it for archives", async () => {
    seedReadyAgent();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await renderAgentPanel(root);
    expect(latestComposerCwd.current).toBe("/workspace/one");
    const composerBaseline = composerRenderCount.mock.calls.length;
    expect(composerBaseline).toBeGreaterThan(0);

    await updateCurrentAgentCwd("/workspace/two");

    expect(latestComposerCwd.current).toBe("/workspace/two");
    expect(composerRenderCount.mock.calls.length).toBeGreaterThan(composerBaseline);

    await act(async () => {
      useSessionStore.getState().setAgents("server", (previous) => {
        const current = previous.get("agent");
        if (!current) {
          throw new Error("Expected seeded agent");
        }
        const next = new Map(previous);
        next.set("agent", { ...current, archivedAt: new Date("2026-04-20T00:00:02.000Z") });
        return next;
      });
      await Promise.resolve();
    });

    expect(composerUnmountCount).toHaveBeenCalledTimes(1);
  });

  it("keeps stream permissions stable for unrelated pending permission updates", async () => {
    seedReadyAgent();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await renderAgentPanel(root);
    const initialRenderCount = streamRenderCount.mock.calls.length;
    expect(initialRenderCount).toBeGreaterThan(0);
    expect(latestStreamPermissionKeys.current).toEqual([]);

    const unrelatedPermission = makePendingPermission("other-agent", "unrelated");
    updatePendingPermissions([unrelatedPermission]);

    expect(latestStreamPermissionKeys.current).toEqual([]);
    expect(streamRenderCount).toHaveBeenCalledTimes(initialRenderCount);

    const agentPermission = makePendingPermission("agent", "current-agent");
    updatePendingPermissions([unrelatedPermission, agentPermission]);

    expect(latestStreamPermissionKeys.current).toEqual(["agent:current-agent"]);
    expect(streamRenderCount).toHaveBeenCalledTimes(initialRenderCount + 1);

    updatePendingPermissions([unrelatedPermission]);

    expect(latestStreamPermissionKeys.current).toEqual([]);
    expect(streamRenderCount).toHaveBeenCalledTimes(initialRenderCount + 2);
  });
});
