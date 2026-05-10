/**
 * @vitest-environment jsdom
 */
import React, { type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DaemonClient, FetchRecentProviderSessionEntry } from "@server/client/daemon-client";
import type { ProviderSnapshotEntry } from "@server/server/agent/agent-sdk-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceImportSheet } from "@/screens/workspace/workspace-import-sheet";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 1.5: 6, 2: 8, 3: 12, 4: 16, 6: 24 },
    borderWidth: { 1: 1 },
    borderRadius: { md: 6, lg: 8, full: 9999 },
    fontSize: { xs: 11, sm: 13, base: 15 },
    fontWeight: { normal: "400", medium: "500", semibold: "600" },
    iconSize: { sm: 14, md: 16 },
    opacity: { 50: 0.5 },
    colors: {
      foreground: "#fff",
      foregroundMuted: "#aaa",
      surface0: "#000",
      surface1: "#111",
      surface2: "#222",
      surface3: "#333",
      border: "#444",
      borderAccent: "#555",
    },
  },
}));

vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
});

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  useUnistyles: () => ({ theme }),
  withUnistyles:
    (Component: React.ComponentType<Record<string, unknown>>) =>
    ({
      uniProps,
      ...rest
    }: {
      uniProps?: (theme: unknown) => Record<string, unknown>;
    } & Record<string, unknown>) => {
      const themed = uniProps ? uniProps(theme) : {};
      return React.createElement(Component, { ...rest, ...themed });
    },
}));

vi.mock("@/constants/layout", () => ({
  useIsCompactFormFactor: () => false,
}));

vi.mock("@/components/provider-icons", () => ({
  getProviderIcon: () => () => null,
}));

vi.mock("@/components/ui/loading-spinner", () => ({
  LoadingSpinner: () =>
    React.createElement("span", { "data-testid": "workspace-import-loading-spinner" }),
}));

vi.mock("@/components/ui/segmented-control", () => ({
  SegmentedControl: ({
    options,
    value,
    onValueChange,
    testID,
  }: {
    options: ReadonlyArray<{ value: string; label: string; testID?: string }>;
    value: string;
    onValueChange: (value: string) => void;
    testID?: string;
  }) =>
    React.createElement(
      "div",
      { "data-testid": testID },
      options.map((option) =>
        React.createElement(
          "button",
          {
            key: option.value,
            type: "button",
            "data-testid": option.testID,
            "data-selected": value === option.value,
            onClick: () => onValueChange(option.value),
          },
          option.label,
        ),
      ),
    ),
}));

vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({
    visible,
    title,
    children,
    testID,
  }: {
    visible: boolean;
    title: string;
    children: ReactNode;
    testID?: string;
  }) =>
    visible ? (
      <section data-testid={testID}>
        <h1>{title}</h1>
        {children}
      </section>
    ) : null,
}));

vi.mock("react-native", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("react-native");
  return actual;
});

const mockSnapshot = vi.hoisted(() => ({
  current: {
    entries: undefined as ProviderSnapshotEntry[] | undefined,
    supportsSnapshot: false,
  },
}));

vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({
    entries: mockSnapshot.current.entries,
    isLoading: false,
    isFetching: false,
    isRefreshing: false,
    error: null,
    supportsSnapshot: mockSnapshot.current.supportsSnapshot,
    refresh: vi.fn(),
    refetchIfStale: vi.fn(),
  }),
}));

interface RenderOptions {
  visible?: boolean;
  onClose?: () => void;
  onImportedAgent?: (agentId: string) => void;
  snapshot?: {
    entries?: ProviderSnapshotEntry[];
    supportsSnapshot?: boolean;
  };
}

function renderSheet(
  client: Pick<DaemonClient, "fetchRecentProviderSessions" | "importAgent">,
  options?: RenderOptions,
) {
  mockSnapshot.current = {
    entries: options?.snapshot?.entries,
    supportsSnapshot: options?.snapshot?.supportsSnapshot ?? false,
  };

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <WorkspaceImportSheet
        visible={options?.visible ?? true}
        client={client}
        serverId="server-1"
        workspaceDirectory="/repo/paseo"
        onClose={options?.onClose ?? vi.fn()}
        onImportedAgent={options?.onImportedAgent ?? vi.fn()}
      />
    </QueryClientProvider>,
  );
}

function createRecentSessionsClient(
  fetchRecentProviderSessions: Pick<
    DaemonClient,
    "fetchRecentProviderSessions"
  >["fetchRecentProviderSessions"],
  importAgent: Pick<DaemonClient, "importAgent">["importAgent"],
): Pick<DaemonClient, "fetchRecentProviderSessions" | "importAgent"> {
  return { fetchRecentProviderSessions, importAgent };
}

function createImportedAgentSnapshot(id: string): Awaited<ReturnType<DaemonClient["importAgent"]>> {
  return {
    id,
    provider: "custom-provider",
    cwd: "/repo/paseo",
    model: null,
    createdAt: "2026-04-30T10:00:00.000Z",
    updatedAt: "2026-04-30T10:00:00.000Z",
    lastUserMessageAt: "2026-04-30T10:00:00.000Z",
    status: "idle",
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
    labels: {},
  };
}

function createProviderSessionEntry(
  overrides?: Partial<FetchRecentProviderSessionEntry>,
): FetchRecentProviderSessionEntry {
  return {
    providerId: "custom-provider",
    providerLabel: "Custom Agent",
    providerHandleId: "provider-thread-1",
    cwd: "/repo/paseo",
    title: "Import me",
    firstPromptPreview: "Import this external provider session",
    lastPromptPreview: "Import this external provider session",
    lastActivityAt: "2026-04-30T10:00:00.000Z",
    ...overrides,
  };
}

const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

function createSnapshotEntry(
  provider: string,
  overrides?: Partial<ProviderSnapshotEntry>,
): ProviderSnapshotEntry {
  return {
    provider,
    status: "ready",
    enabled: true,
    label: PROVIDER_LABELS[provider] ?? provider,
    ...overrides,
  };
}

describe("WorkspaceImportSheet", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows an update-host message when the daemon does not support provider snapshots", async () => {
    const fetchRecentProviderSessions = vi.fn();
    const importAgent = vi.fn();

    renderSheet({ fetchRecentProviderSessions, importAgent } as Pick<
      DaemonClient,
      "fetchRecentProviderSessions" | "importAgent"
    >);

    await screen.findByText("Update the host to import sessions.");
    expect(fetchRecentProviderSessions).not.toHaveBeenCalled();
  });

  it("shows a loading state while provider snapshot is loading", async () => {
    const fetchRecentProviderSessions = vi.fn(
      () => new Promise<Awaited<ReturnType<DaemonClient["fetchRecentProviderSessions"]>>>(() => {}),
    );
    const importAgent = vi.fn();

    renderSheet(
      { fetchRecentProviderSessions, importAgent } as Pick<
        DaemonClient,
        "fetchRecentProviderSessions" | "importAgent"
      >,
      {
        snapshot: { supportsSnapshot: true, entries: undefined },
      },
    );

    await screen.findByText("Loading recent sessions...");
    expect(fetchRecentProviderSessions).not.toHaveBeenCalled();
  });

  it("shows an empty state when there are no recent provider sessions to import", async () => {
    const fetchRecentProviderSessions = vi.fn(async () => ({
      requestId: "recent-provider-sessions",
      entries: [],
    }));
    const importAgent = vi.fn();

    renderSheet(
      { fetchRecentProviderSessions, importAgent } as Pick<
        DaemonClient,
        "fetchRecentProviderSessions" | "importAgent"
      >,
      {
        snapshot: { supportsSnapshot: true, entries: [createSnapshotEntry("claude")] },
      },
    );

    await screen.findByText("No recent sessions to import.");
  });

  it("shows the all-already-imported empty state when filteredAlreadyImportedCount is positive", async () => {
    const fetchRecentProviderSessions = vi.fn(async () => ({
      requestId: "recent-provider-sessions",
      entries: [],
      filteredAlreadyImportedCount: 3,
    }));
    const importAgent = vi.fn();

    renderSheet(
      { fetchRecentProviderSessions, importAgent } as Pick<
        DaemonClient,
        "fetchRecentProviderSessions" | "importAgent"
      >,
      {
        snapshot: { supportsSnapshot: true, entries: [createSnapshotEntry("claude")] },
      },
    );

    await screen.findByText("All recent sessions are already imported.");
    expect(screen.queryByText("No recent sessions to import.")).toBeNull();
  });

  it("shows a fetch error state when recent provider sessions cannot be loaded", async () => {
    const fetchRecentProviderSessions = vi.fn(async () => {
      throw new Error("recent sessions unavailable");
    });
    const importAgent = vi.fn();

    renderSheet(
      { fetchRecentProviderSessions, importAgent } as Pick<
        DaemonClient,
        "fetchRecentProviderSessions" | "importAgent"
      >,
      {
        snapshot: { supportsSnapshot: true, entries: [createSnapshotEntry("claude")] },
      },
    );

    await screen.findByText("Could not load recent sessions.");
  });

  it("loads recent provider sessions for the workspace and renders descriptor-owned labels", async () => {
    vi.setSystemTime(new Date("2026-04-30T12:00:00.000Z"));
    const fetchRecentProviderSessions = vi.fn(async () => ({
      requestId: "recent-provider-sessions",
      entries: [
        createProviderSessionEntry({
          providerId: "claude",
          providerLabel: "Claude Code",
          title: null,
          firstPromptPreview: "Implement the importer sheet",
          lastPromptPreview: "Make the rows readable and provider opaque",
        }),
      ],
    }));
    const importAgent = vi.fn();

    renderSheet(
      { fetchRecentProviderSessions, importAgent } as Pick<
        DaemonClient,
        "fetchRecentProviderSessions" | "importAgent"
      >,
      {
        snapshot: { supportsSnapshot: true, entries: [createSnapshotEntry("claude")] },
      },
    );

    await waitFor(() => {
      expect(fetchRecentProviderSessions).toHaveBeenCalledWith({
        cwd: "/repo/paseo",
        providers: ["claude"],
        limit: 15,
      });
    });

    await screen.findByText("Implement the importer sheet");
    screen.getByText("2h ago");
    screen.getByText("Make the rows readable and provider opaque");
  });

  it("keeps cached rows visible and revalidates when reopened", async () => {
    const fetchRecentProviderSessions = vi.fn(async () => ({
      requestId: "recent-provider-sessions",
      entries: [
        createProviderSessionEntry({
          providerId: "claude",
          providerLabel: "Claude Code",
          title: "Cached importable session",
        }),
      ],
    }));
    const importAgent = vi.fn();
    const client = createRecentSessionsClient(fetchRecentProviderSessions, importAgent);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    mockSnapshot.current = {
      entries: [createSnapshotEntry("claude")],
      supportsSnapshot: true,
    };

    function TestSheet({ visible }: { visible: boolean }) {
      return (
        <QueryClientProvider client={queryClient}>
          <WorkspaceImportSheet
            visible={visible}
            client={client}
            serverId="server-1"
            workspaceDirectory="/repo/paseo"
            onClose={vi.fn()}
            onImportedAgent={vi.fn()}
          />
        </QueryClientProvider>
      );
    }

    const { rerender } = render(<TestSheet visible />);

    await screen.findByText("Cached importable session");
    expect(fetchRecentProviderSessions).toHaveBeenCalledTimes(1);

    rerender(<TestSheet visible={false} />);
    fetchRecentProviderSessions.mockClear();
    rerender(<TestSheet visible />);

    await screen.findByText("Cached importable session");
    await waitFor(() => {
      expect(fetchRecentProviderSessions).toHaveBeenCalledWith({
        cwd: "/repo/paseo",
        providers: ["claude"],
        limit: 15,
      });
    });
  });

  it("imports a selected session by provider handle and reports the imported agent", async () => {
    const fetchRecentProviderSessions = vi.fn(async () => ({
      requestId: "recent-provider-sessions",
      entries: [createProviderSessionEntry({ providerId: "claude", providerLabel: "Claude Code" })],
    }));
    const importAgent = vi.fn(async () => createImportedAgentSnapshot("agent-imported"));
    const onClose = vi.fn();
    const onImportedAgent = vi.fn();

    renderSheet(
      { fetchRecentProviderSessions, importAgent } as Pick<
        DaemonClient,
        "fetchRecentProviderSessions" | "importAgent"
      >,
      {
        onClose,
        onImportedAgent,
        snapshot: { supportsSnapshot: true, entries: [createSnapshotEntry("claude")] },
      },
    );

    fireEvent.click(await screen.findByTestId("workspace-import-session-claude-provider-thread-1"));

    await waitFor(() => {
      expect(importAgent).toHaveBeenCalledWith({
        providerId: "claude",
        providerHandleId: "provider-thread-1",
        cwd: "/repo/paseo",
      });
    });
    expect(onImportedAgent).toHaveBeenCalledWith("agent-imported");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows an import error state without closing when selected session import fails", async () => {
    const fetchRecentProviderSessions = vi.fn(async () => ({
      requestId: "recent-provider-sessions",
      entries: [createProviderSessionEntry({ providerId: "claude", providerLabel: "Claude Code" })],
    }));
    const importAgent = vi.fn(async () => {
      throw new Error("import unavailable");
    });
    const onClose = vi.fn();
    const onImportedAgent = vi.fn();

    renderSheet(
      { fetchRecentProviderSessions, importAgent } as Pick<
        DaemonClient,
        "fetchRecentProviderSessions" | "importAgent"
      >,
      {
        onClose,
        onImportedAgent,
        snapshot: { supportsSnapshot: true, entries: [createSnapshotEntry("claude")] },
      },
    );

    fireEvent.click(await screen.findByTestId("workspace-import-session-claude-provider-thread-1"));

    await screen.findByText("Could not import selected session.");
    expect(importAgent).toHaveBeenCalledWith({
      providerId: "claude",
      providerHandleId: "provider-thread-1",
      cwd: "/repo/paseo",
    });
    expect(onImportedAgent).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("fans out one request per enabled importable provider when snapshot is supported", async () => {
    const fetchRecentProviderSessions = vi.fn(
      async (options: { providers?: string[] } | undefined) => ({
        requestId: `recent-${options?.providers?.[0] ?? "all"}`,
        entries: [
          createProviderSessionEntry({
            providerId: options?.providers?.[0] ?? "custom-provider",
            providerLabel: options?.providers?.[0] ?? "Custom",
            providerHandleId: `${options?.providers?.[0] ?? "custom-provider"}-thread`,
            title: `Session ${options?.providers?.[0] ?? "all"}`,
            lastActivityAt: "2026-04-30T10:00:00.000Z",
          }),
        ],
      }),
    );
    const importAgent = vi.fn();

    renderSheet(
      { fetchRecentProviderSessions, importAgent } as Pick<
        DaemonClient,
        "fetchRecentProviderSessions" | "importAgent"
      >,
      {
        snapshot: {
          supportsSnapshot: true,
          entries: [
            createSnapshotEntry("claude"),
            createSnapshotEntry("codex"),
            createSnapshotEntry("opencode", { enabled: false }),
            createSnapshotEntry("z-ai"),
          ],
        },
      },
    );

    await waitFor(() => {
      expect(fetchRecentProviderSessions).toHaveBeenCalledWith({
        cwd: "/repo/paseo",
        providers: ["claude"],
        limit: 15,
      });
    });
    expect(fetchRecentProviderSessions).toHaveBeenCalledWith({
      cwd: "/repo/paseo",
      providers: ["codex"],
      limit: 15,
    });
    expect(fetchRecentProviderSessions).not.toHaveBeenCalledWith(
      expect.objectContaining({ providers: ["opencode"] }),
    );
    expect(fetchRecentProviderSessions).not.toHaveBeenCalledWith(
      expect.objectContaining({ providers: ["z-ai"] }),
    );

    await screen.findByText("Session claude");
    await screen.findByText("Session codex");
  });

  it("shows partial-failure note when one provider request fails but others succeed", async () => {
    const fetchRecentProviderSessions = vi.fn(
      async (options: { providers?: string[] } | undefined) => {
        const provider = options?.providers?.[0];
        if (provider === "claude") {
          throw new Error("claude offline");
        }
        return {
          requestId: `recent-${provider ?? "all"}`,
          entries: [
            createProviderSessionEntry({
              providerId: provider ?? "custom-provider",
              providerHandleId: `${provider}-thread`,
              providerLabel: provider ?? "Custom",
              title: `Session ${provider}`,
            }),
          ],
        };
      },
    );
    const importAgent = vi.fn();

    renderSheet(
      { fetchRecentProviderSessions, importAgent } as Pick<
        DaemonClient,
        "fetchRecentProviderSessions" | "importAgent"
      >,
      {
        snapshot: {
          supportsSnapshot: true,
          entries: [createSnapshotEntry("claude"), createSnapshotEntry("codex")],
        },
      },
    );

    await screen.findByText("Session codex");
    await screen.findByText("Could not load sessions for Claude Code.");
  });

  it("filters the merged list when a provider badge is selected and restores it on All", async () => {
    const fetchRecentProviderSessions = vi.fn(
      async (options: { providers?: string[] } | undefined) => {
        const provider = options?.providers?.[0] ?? "claude";
        return {
          requestId: `recent-${provider}`,
          entries: [
            createProviderSessionEntry({
              providerId: provider,
              providerLabel: provider === "claude" ? "Claude Code" : "Codex",
              providerHandleId: `${provider}-thread`,
              title: `Session ${provider}`,
              lastActivityAt:
                provider === "claude" ? "2026-04-30T09:00:00.000Z" : "2026-04-30T10:00:00.000Z",
            }),
          ],
        };
      },
    );
    const importAgent = vi.fn();

    renderSheet(
      { fetchRecentProviderSessions, importAgent } as Pick<
        DaemonClient,
        "fetchRecentProviderSessions" | "importAgent"
      >,
      {
        snapshot: {
          supportsSnapshot: true,
          entries: [createSnapshotEntry("claude"), createSnapshotEntry("codex")],
        },
      },
    );

    await screen.findByText("Session claude");
    await screen.findByText("Session codex");

    fireEvent.click(screen.getByTestId("workspace-import-filter-codex"));

    screen.getByText("Session codex");
    expect(screen.queryByText("Session claude")).toBeNull();

    fireEvent.click(screen.getByTestId("workspace-import-filter-all"));

    screen.getByText("Session claude");
    screen.getByText("Session codex");
  });

  it("does not render filter badges when only one importable provider is enabled", async () => {
    const fetchRecentProviderSessions = vi.fn(async () => ({
      requestId: "recent-codex",
      entries: [createProviderSessionEntry({ providerId: "codex", providerLabel: "Codex" })],
    }));
    const importAgent = vi.fn();

    renderSheet(
      { fetchRecentProviderSessions, importAgent } as Pick<
        DaemonClient,
        "fetchRecentProviderSessions" | "importAgent"
      >,
      {
        snapshot: {
          supportsSnapshot: true,
          entries: [
            createSnapshotEntry("codex"),
            createSnapshotEntry("claude", { enabled: false }),
          ],
        },
      },
    );

    await waitFor(() => {
      expect(fetchRecentProviderSessions).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("workspace-import-filters")).toBeNull();
    expect(screen.queryByTestId("workspace-import-filter-all")).toBeNull();
  });

  it("shows a no-importable-providers message when snapshot has no enabled importable providers", async () => {
    const fetchRecentProviderSessions = vi.fn();
    const importAgent = vi.fn();

    renderSheet(
      { fetchRecentProviderSessions, importAgent } as Pick<
        DaemonClient,
        "fetchRecentProviderSessions" | "importAgent"
      >,
      {
        snapshot: {
          supportsSnapshot: true,
          entries: [
            createSnapshotEntry("claude", { enabled: false }),
            createSnapshotEntry("codex", { enabled: false }),
            createSnapshotEntry("opencode", { enabled: false }),
            createSnapshotEntry("z-ai"),
          ],
        },
      },
    );

    await screen.findByText("No importable providers are enabled.");
    expect(fetchRecentProviderSessions).not.toHaveBeenCalled();
  });
});
