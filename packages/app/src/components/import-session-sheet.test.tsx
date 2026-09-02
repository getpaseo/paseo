/**
 * @vitest-environment jsdom
 */
import React, { type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  DaemonClient,
  FetchRecentProviderSessionEntry,
} from "@getpaseo/client/internal/daemon-client";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportSessionSheet } from "@/components/import-session-sheet";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 1.5: 6, 2: 8, 2.5: 10, 3: 12, 4: 16, 6: 24, 8: 32 },
    borderWidth: { 1: 1 },
    borderRadius: { md: 6, lg: 8, full: 9999 },
    fontSize: { xs: 11, sm: 13, base: 15 },
    fontWeight: { normal: "400", medium: "500", semibold: "600" },
    iconSize: { sm: 14, md: 16, lg: 24 },
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
      interactionHighlight: "rgba(255,255,255,0.08)",
      palette: { red: { 300: "#f87171" } },
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

vi.mock("lucide-react-native", () => {
  const icon = (name: string) => {
    const Icon = () => React.createElement("span", { "data-icon": name });
    Icon.displayName = name;
    return Icon;
  };
  return {
    ChevronDown: icon("ChevronDown"),
    Inbox: icon("Inbox"),
    Layers: icon("Layers"),
    RotateCw: icon("RotateCw"),
    Search: icon("Search"),
    X: icon("X"),
  };
});

vi.mock("@/components/ui/loading-spinner", () => ({
  LoadingSpinner: () =>
    React.createElement("span", { "data-testid": "import-session-loading-spinner" }),
}));

vi.mock("@/components/ui/combobox", () => ({
  Combobox: ({
    options,
    value,
    onSelect,
    open,
  }: {
    options: ReadonlyArray<{ id: string; label: string }>;
    value: string;
    onSelect: (id: string) => void;
    open?: boolean;
  }) => {
    if (!open) return null;
    return React.createElement(
      "div",
      { "data-testid": "import-session-combobox" },
      options.map((option) =>
        React.createElement(
          "button",
          {
            key: option.id,
            type: "button",
            "data-testid": `import-session-filter-${option.id === "__all__" ? "all" : option.id}`,
            "data-selected": value === option.id,
            onClick: () => onSelect(option.id),
          },
          option.label,
        ),
      ),
    );
  },
  ComboboxItem: ({ label }: { label: string }) => React.createElement("span", null, label),
}));

interface SheetSearchProps {
  onChange: (value: string) => void;
  placeholder?: string;
  testID?: string;
}

function SheetSearchInput({ search }: { search: SheetSearchProps }) {
  const handleChange = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => search.onChange(event.target.value),
    [search],
  );
  return (
    <input data-testid={search.testID} placeholder={search.placeholder} onChange={handleChange} />
  );
}

vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({
    visible,
    header,
    children,
    testID,
  }: {
    visible: boolean;
    header?: {
      title: string;
      subtitle?: ReactNode;
      actions?: ReactNode;
      search?: { onChange: (value: string) => void; placeholder?: string; testID?: string };
    };
    children: ReactNode;
    testID?: string;
  }) =>
    visible ? (
      <section data-testid={testID}>
        <h1>{header?.title}</h1>
        {header?.subtitle}
        {header?.actions}
        {header?.search ? <SheetSearchInput search={header.search} /> : null}
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

const mockHostFeatures = vi.hoisted(() => ({
  current: { importSessionSearch: true, importSessionWorkspaceTarget: true } as Record<
    string,
    boolean
  >,
}));

vi.mock("@/runtime/host-features", () => ({
  useHostFeature: (_serverId: string | null, feature: string) =>
    mockHostFeatures.current[feature] === true,
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => [{ serverId: "server-1", label: "workbench" }],
}));

const mockHostProjects = vi.hoisted(() => ({
  current: [] as Array<{ iconWorkingDir: string; projectName: string }>,
}));

vi.mock("@/projects/host-projects", () => ({
  useHostProjects: () => mockHostProjects.current,
}));

interface RenderOptions {
  visible?: boolean;
  onClose?: () => void;
  onImportedAgent?: (agentId: string) => void;
  onImported?: (agent: Awaited<ReturnType<DaemonClient["importAgent"]>>) => void;
  cwd?: string | null;
  workspaceId?: string;
  supportsSearch?: boolean;
  projects?: Array<{ iconWorkingDir: string; projectName: string }>;
  snapshot?: {
    entries?: ProviderSnapshotEntry[];
    supportsSnapshot?: boolean;
  };
}

function applyHostMocks(options?: RenderOptions) {
  mockSnapshot.current = {
    entries: options?.snapshot?.entries,
    supportsSnapshot: options?.snapshot?.supportsSnapshot ?? false,
  };
  mockHostFeatures.current = {
    importSessionSearch: options?.supportsSearch ?? true,
    importSessionWorkspaceTarget: true,
  };
  mockHostProjects.current = options?.projects ?? [];
}

function renderSheet(
  client: Pick<DaemonClient, "fetchRecentProviderSessions" | "importAgent">,
  options?: RenderOptions,
) {
  applyHostMocks(options);

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  const cwd = options && "cwd" in options ? (options.cwd ?? undefined) : "/repo/paseo";

  return render(
    <QueryClientProvider client={queryClient}>
      <ImportSessionSheet
        visible={options?.visible ?? true}
        client={client}
        serverId="server-1"
        cwd={cwd}
        workspaceId={options?.workspaceId}
        onClose={options?.onClose ?? vi.fn()}
        onImportedAgent={options?.onImportedAgent ?? vi.fn()}
        onImported={options?.onImported}
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

function createPageOfEntries(count: number): FetchRecentProviderSessionEntry[] {
  return Array.from({ length: count }, (_unused, index) =>
    createProviderSessionEntry({
      providerId: "claude",
      providerHandleId: `thread-${index}`,
      title: `Session ${index}`,
    }),
  );
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

describe("ImportSessionSheet", () => {
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

    await screen.findByText("Could not load Claude Code sessions");
    screen.getByTestId("import-session-retry-claude");
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
          <ImportSessionSheet
            visible={visible}
            client={client}
            serverId="server-1"
            cwd="/repo/paseo"
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
    const events: string[] = [];
    let fetchCount = 0;
    const fetchRecentProviderSessions = vi.fn(async () => {
      fetchCount += 1;
      events.push("fetch");
      if (fetchCount > 1) {
        return await new Promise<never>(() => {});
      }
      return {
        requestId: "recent-provider-sessions",
        entries: [
          createProviderSessionEntry({
            providerId: "claude",
            providerLabel: "Claude Code",
            cwd: "/repo/paseo-realpath",
          }),
        ],
      };
    });
    let resolveImport!: (agent: ReturnType<typeof createImportedAgentSnapshot>) => void;
    const importAgent = vi.fn(
      () =>
        new Promise<ReturnType<typeof createImportedAgentSnapshot>>((resolve) => {
          resolveImport = resolve;
        }),
    );
    const onClose = vi.fn(() => events.push("close"));
    const onImportedAgent = vi.fn(() => events.push("navigate"));

    renderSheet(
      { fetchRecentProviderSessions, importAgent } as Pick<
        DaemonClient,
        "fetchRecentProviderSessions" | "importAgent"
      >,
      {
        onClose,
        onImportedAgent,
        workspaceId: "ws-current",
        snapshot: { supportsSnapshot: true, entries: [createSnapshotEntry("claude")] },
      },
    );

    const row = await screen.findByTestId("import-session-session-claude-provider-thread-1");
    expect(events).toEqual(["fetch"]);
    fireEvent.click(row);

    await screen.findByText("Importing...");
    expect(events).toEqual(["fetch"]);
    resolveImport(createImportedAgentSnapshot("agent-imported"));

    await waitFor(() => {
      expect(importAgent).toHaveBeenCalledWith({
        providerId: "claude",
        providerHandleId: "provider-thread-1",
        cwd: "/repo/paseo-realpath",
        workspaceId: "ws-current",
      });
      expect(events).toEqual(["fetch", "close", "navigate"]);
    });
    expect(onImportedAgent).toHaveBeenCalledWith("agent-imported");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(fetchRecentProviderSessions).toHaveBeenCalledTimes(1);
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

    fireEvent.click(await screen.findByTestId("import-session-session-claude-provider-thread-1"));

    await screen.findByText("Could not import selected session.");
    expect(importAgent).toHaveBeenCalledWith({
      providerId: "claude",
      providerHandleId: "provider-thread-1",
      cwd: "/repo/paseo",
    });
    expect(onImportedAgent).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("fans out one request per enabled provider when snapshot is supported", async () => {
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
    expect(fetchRecentProviderSessions).toHaveBeenCalledWith({
      cwd: "/repo/paseo",
      providers: ["z-ai"],
      limit: 15,
    });

    await screen.findByText("Session claude");
    await screen.findByText("Session codex");
    await screen.findByText("Session z-ai");
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
    await screen.findByText("Could not load Claude Code sessions");
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

    fireEvent.click(screen.getByTestId("import-session-filter-trigger"));
    fireEvent.click(screen.getByTestId("import-session-filter-codex"));

    screen.getByText("Session codex");
    expect(screen.queryByText("Session claude")).toBeNull();

    fireEvent.click(screen.getByTestId("import-session-filter-trigger"));
    fireEvent.click(screen.getByTestId("import-session-filter-all"));

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
    expect(screen.queryByTestId("import-session-filters")).toBeNull();
    expect(screen.queryByTestId("import-session-filter-all")).toBeNull();
  });

  it("shows a no-importable-providers message when snapshot has no enabled providers", async () => {
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
            createSnapshotEntry("z-ai", { enabled: false }),
          ],
        },
      },
    );

    await screen.findByText("No importable providers are enabled.");
    expect(fetchRecentProviderSessions).not.toHaveBeenCalled();
  });

  it("omits cwd from fetch and names each row's folder when cwd is unset", async () => {
    const fetchRecentProviderSessions = vi.fn(async () => ({
      requestId: "recent-provider-sessions",
      entries: [
        createProviderSessionEntry({
          providerId: "claude",
          providerLabel: "Claude Code",
          cwd: "/home/me/work/other-project",
          title: "Cross-project session",
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
        cwd: null,
        snapshot: { supportsSnapshot: true, entries: [createSnapshotEntry("claude")] },
      },
    );

    await waitFor(() => {
      expect(fetchRecentProviderSessions).toHaveBeenCalledWith({
        providers: ["claude"],
        limit: 15,
      });
    });
    expect(fetchRecentProviderSessions).not.toHaveBeenCalledWith(
      expect.objectContaining({ cwd: expect.anything() }),
    );
    await screen.findByText("/home/me/work/other-project");
    expect(
      screen.getByTestId("import-session-row-folder-claude-provider-thread-1").textContent,
    ).toBe("/home/me/work/other-project");
  });

  it("uses the session's cwd when importing in cwd-less mode and fires onImported", async () => {
    const fetchRecentProviderSessions = vi.fn(async () => ({
      requestId: "recent-provider-sessions",
      entries: [
        createProviderSessionEntry({
          providerId: "claude",
          providerLabel: "Claude Code",
          cwd: "/home/me/work/other-project",
        }),
      ],
    }));
    const importAgent = vi.fn(async () => createImportedAgentSnapshot("agent-imported"));
    const onImported = vi.fn();
    const onImportedAgent = vi.fn();
    const onClose = vi.fn();

    renderSheet(
      { fetchRecentProviderSessions, importAgent } as Pick<
        DaemonClient,
        "fetchRecentProviderSessions" | "importAgent"
      >,
      {
        cwd: null,
        onClose,
        onImported,
        onImportedAgent,
        snapshot: { supportsSnapshot: true, entries: [createSnapshotEntry("claude")] },
      },
    );

    fireEvent.click(await screen.findByTestId("import-session-session-claude-provider-thread-1"));

    await waitFor(() => {
      expect(importAgent).toHaveBeenCalledWith({
        providerId: "claude",
        providerHandleId: "provider-thread-1",
        cwd: "/home/me/work/other-project",
      });
    });
    expect(onImported).toHaveBeenCalledTimes(1);
    expect(onImported).toHaveBeenCalledWith(expect.objectContaining({ id: "agent-imported" }));
    expect(onImportedAgent).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("names the scope after the host when unscoped and after the workspace when scoped", async () => {
    const fetchRecentProviderSessions = vi.fn(async () => ({
      requestId: "recent-provider-sessions",
      entries: [],
    }));
    const importAgent = vi.fn();
    const client = createRecentSessionsClient(fetchRecentProviderSessions, importAgent);

    renderSheet(client, {
      cwd: null,
      snapshot: { supportsSnapshot: true, entries: [createSnapshotEntry("claude")] },
    });
    await screen.findByText("Sessions on workbench");
    expect(screen.queryByTestId("import-session-show-all")).toBeNull();
    cleanup();

    renderSheet(client, {
      workspaceId: "ws-current",
      snapshot: { supportsSnapshot: true, entries: [createSnapshotEntry("claude")] },
    });
    await screen.findByText("This workspace");
    screen.getByTestId("import-session-show-all");
  });

  it("lists unscoped rows newest first and names each row's folder", async () => {
    const fetchRecentProviderSessions = vi.fn(async () => ({
      requestId: "recent-provider-sessions",
      entries: [
        createProviderSessionEntry({
          providerId: "claude",
          providerHandleId: "newest",
          cwd: "/home/me/paseo",
          title: "Newest in paseo",
          lastActivityAt: "2026-04-30T12:00:00.000Z",
        }),
        createProviderSessionEntry({
          providerId: "claude",
          providerHandleId: "elsewhere",
          cwd: "/tmp/scratch",
          title: "Scratch session",
          lastActivityAt: "2026-04-30T11:00:00.000Z",
        }),
        createProviderSessionEntry({
          providerId: "claude",
          providerHandleId: "older",
          cwd: "/home/me/paseo",
          title: "Older in paseo",
          lastActivityAt: "2026-04-30T10:00:00.000Z",
        }),
        createProviderSessionEntry({
          providerId: "claude",
          providerHandleId: "worktree",
          cwd: "/home/me/paseo/.dev/worktrees/zebra",
          title: "Worktree session",
          lastActivityAt: "2026-04-30T09:00:00.000Z",
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
        cwd: null,
        projects: [{ iconWorkingDir: "/home/me/paseo", projectName: "paseo" }],
        snapshot: { supportsSnapshot: true, entries: [createSnapshotEntry("claude")] },
      },
    );

    await screen.findByTestId("import-session-session-claude-newest");
    expect(
      screen
        .getAllByTestId(/^import-session-session-/)
        .map((row) => row.getAttribute("data-testid")),
    ).toEqual([
      "import-session-session-claude-newest",
      "import-session-session-claude-elsewhere",
      "import-session-session-claude-older",
      "import-session-session-claude-worktree",
    ]);
    expect(
      screen.getAllByTestId(/^import-session-row-folder-/).map((folder) => folder.textContent),
    ).toEqual(["paseo", "/tmp/scratch", "paseo", "paseo · .dev/worktrees/zebra"]);
  });

  it("leaves the folder off every row when the sheet is scoped to one workspace", async () => {
    const fetchRecentProviderSessions = vi.fn(async () => ({
      requestId: "recent-provider-sessions",
      entries: [
        createProviderSessionEntry({
          providerId: "claude",
          providerHandleId: "scoped",
          cwd: "/repo/paseo",
          title: "Scoped session",
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
        workspaceId: "ws-current",
        projects: [{ iconWorkingDir: "/repo/paseo", projectName: "paseo" }],
        snapshot: { supportsSnapshot: true, entries: [createSnapshotEntry("claude")] },
      },
    );

    await screen.findByText("Scoped session");
    expect(screen.queryAllByTestId(/^import-session-row-folder-/)).toHaveLength(0);
  });

  it("sends the debounced search query to every provider", async () => {
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
        cwd: null,
        snapshot: { supportsSnapshot: true, entries: [createSnapshotEntry("claude")] },
      },
    );

    await waitFor(() => {
      expect(fetchRecentProviderSessions).toHaveBeenCalled();
    });

    fireEvent.change(screen.getByTestId("import-session-search"), {
      target: { value: "invoice" },
    });

    await waitFor(() => {
      expect(fetchRecentProviderSessions).toHaveBeenCalledWith({
        providers: ["claude"],
        limit: 15,
        query: "invoice",
      });
    });
  });

  it("hides the search field when the host cannot search sessions", async () => {
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
        cwd: null,
        supportsSearch: false,
        snapshot: { supportsSnapshot: true, entries: [createSnapshotEntry("claude")] },
      },
    );

    await waitFor(() => {
      expect(fetchRecentProviderSessions).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("import-session-search")).toBeNull();
  });

  it("asks for a larger page when Load more is pressed, and stops offering it on a short page", async () => {
    const fetchRecentProviderSessions = vi.fn(async (options: { limit?: number } | undefined) => ({
      requestId: "recent-provider-sessions",
      entries: createPageOfEntries(options?.limit === 15 ? 15 : 20),
    }));
    const importAgent = vi.fn();

    renderSheet(
      { fetchRecentProviderSessions, importAgent } as Pick<
        DaemonClient,
        "fetchRecentProviderSessions" | "importAgent"
      >,
      {
        cwd: null,
        snapshot: { supportsSnapshot: true, entries: [createSnapshotEntry("claude")] },
      },
    );

    fireEvent.click(await screen.findByTestId("import-session-load-more"));

    await waitFor(() => {
      expect(fetchRecentProviderSessions).toHaveBeenCalledWith({
        providers: ["claude"],
        limit: 45,
      });
    });
    await waitFor(() => {
      expect(screen.queryByTestId("import-session-load-more")).toBeNull();
    });
  });

  it("stops the refresh spinner and retries only the failed provider", async () => {
    const fetchRecentProviderSessions = vi.fn(
      async (options: { providers?: string[] } | undefined) => {
        const provider = options?.providers?.[0];
        if (provider === "claude") {
          throw new Error("claude offline");
        }
        return {
          requestId: `recent-${provider}`,
          entries: [
            createProviderSessionEntry({
              providerId: provider ?? "codex",
              providerHandleId: `${provider}-thread`,
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
    await screen.findByText("Could not load Claude Code sessions");
    await waitFor(() => {
      expect(screen.queryByTestId("import-session-loading-spinner")).toBeNull();
    });

    fetchRecentProviderSessions.mockClear();
    fireEvent.click(screen.getByTestId("import-session-retry-claude"));

    await waitFor(() => {
      expect(fetchRecentProviderSessions).toHaveBeenCalledWith({
        cwd: "/repo/paseo",
        providers: ["claude"],
        limit: 15,
      });
    });
    expect(fetchRecentProviderSessions).toHaveBeenCalledTimes(1);
  });

  it("shows an error row for a provider the daemon reported as failed", async () => {
    const fetchRecentProviderSessions = vi.fn(async () => ({
      requestId: "recent-provider-sessions",
      entries: [createProviderSessionEntry({ providerId: "codex", providerLabel: "Codex" })],
      providerErrors: [{ provider: "codex", message: "timed out" }],
    }));
    const importAgent = vi.fn();

    renderSheet(
      { fetchRecentProviderSessions, importAgent } as Pick<
        DaemonClient,
        "fetchRecentProviderSessions" | "importAgent"
      >,
      {
        snapshot: { supportsSnapshot: true, entries: [createSnapshotEntry("codex")] },
      },
    );

    await screen.findByText("Could not load Codex sessions");
  });

  it("imports a foreign-directory row without the current workspace once Show all is on", async () => {
    const fetchRecentProviderSessions = vi.fn(async (options: { cwd?: string } | undefined) => ({
      requestId: "recent-provider-sessions",
      entries: [
        createProviderSessionEntry({
          providerId: "claude",
          providerHandleId: options?.cwd ? "scoped-thread" : "foreign-thread",
          cwd: options?.cwd ?? "/home/me/work/other-project",
          title: options?.cwd ? "Scoped session" : "Foreign session",
        }),
      ],
    }));
    const importAgent = vi.fn(async () => createImportedAgentSnapshot("agent-imported"));
    const onImported = vi.fn();
    const onImportedAgent = vi.fn();

    renderSheet(
      { fetchRecentProviderSessions, importAgent } as Pick<
        DaemonClient,
        "fetchRecentProviderSessions" | "importAgent"
      >,
      {
        workspaceId: "ws-current",
        onImported,
        onImportedAgent,
        snapshot: { supportsSnapshot: true, entries: [createSnapshotEntry("claude")] },
      },
    );

    await screen.findByText("Scoped session");
    fireEvent.click(screen.getByTestId("import-session-show-all"));

    await screen.findByText("Foreign session");
    expect(fetchRecentProviderSessions).toHaveBeenCalledWith({
      providers: ["claude"],
      limit: 15,
    });

    fireEvent.click(screen.getByTestId("import-session-session-claude-foreign-thread"));

    await waitFor(() => {
      expect(importAgent).toHaveBeenCalledWith({
        providerId: "claude",
        providerHandleId: "foreign-thread",
        cwd: "/home/me/work/other-project",
      });
    });
    expect(onImported).toHaveBeenCalledWith(expect.objectContaining({ id: "agent-imported" }));
    expect(onImportedAgent).not.toHaveBeenCalled();
  });

  it("refetches sessions when the refresh button is clicked", async () => {
    const fetchRecentProviderSessions = vi.fn(async () => ({
      requestId: "recent-provider-sessions",
      entries: [
        createProviderSessionEntry({
          providerId: "claude",
          providerLabel: "Claude Code",
          title: "Refreshable session",
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

    await screen.findByText("Refreshable session");
    expect(fetchRecentProviderSessions).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("import-session-refresh"));

    await waitFor(() => {
      expect(fetchRecentProviderSessions).toHaveBeenCalledTimes(2);
    });
  });
});
