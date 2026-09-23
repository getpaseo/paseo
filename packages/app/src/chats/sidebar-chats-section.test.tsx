/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarChatsSection } from "./sidebar-chats-section";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { confirmDialog } from "@/utils/confirm-dialog";
import { archiveWorkspacesOptimistically } from "@/workspace/workspace-archive";
import { redirectIfArchivingActiveWorkspace } from "@/utils/sidebar-workspace-archive-redirect";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";

vi.mock("react-native", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-native")>();
  const passthrough = ({
    children,
    testID,
    accessibilityLabel,
    accessibilityRole,
    onPress,
    disabled,
    ...rest
  }: {
    children?:
      | React.ReactNode
      | ((state: { pressed: boolean; hovered: boolean }) => React.ReactNode);
    testID?: string;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    onPress?: (event: { stopPropagation: () => void }) => void;
    disabled?: boolean;
  } & Record<string, unknown>) => {
    const dataAttrs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (key.startsWith("data-")) {
        dataAttrs[key] = value;
      }
    }
    return React.createElement(
      "button",
      {
        type: "button",
        role: accessibilityRole,
        "aria-label": accessibilityLabel,
        "data-testid": testID,
        disabled,
        onClick: onPress
          ? (event: React.MouseEvent) => {
              onPress({ stopPropagation: () => event.stopPropagation() });
            }
          : undefined,
        ...dataAttrs,
      },
      typeof children === "function" ? children({ pressed: false, hovered: false }) : children,
    );
  };

  return {
    ...actual,
    View: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
      React.createElement("div", { "data-testid": testID }, children),
    Text: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("span", null, children),
    Pressable: passthrough,
    Platform: {
      OS: "web",
      select: <T,>(options: { web?: T; default?: T }) => options.web ?? options.default,
    },
  };
});

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

vi.mock("@/components/sidebar/sidebar-header-row", () => ({
  SidebarHeaderRow: ({
    label,
    onPress,
    testID,
  }: {
    label: string;
    onPress: () => void;
    testID?: string;
  }) =>
    React.createElement(
      "button",
      { type: "button", "data-testid": testID, onClick: onPress },
      label,
    ),
}));

const mockToast = {
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
};

vi.mock("@/contexts/toast-context", () => ({
  useToast: () => mockToast,
}));

vi.mock("@/utils/confirm-dialog", () => ({
  confirmDialog: vi.fn(),
}));

vi.mock("@/workspace/workspace-archive", () => ({
  archiveWorkspacesOptimistically: vi.fn(),
}));

vi.mock("@/utils/sidebar-workspace-archive-redirect", () => ({
  redirectIfArchivingActiveWorkspace: vi.fn(),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => [{ serverId: "server-1", name: "Local Host" }],
  getHostRuntimeStore: () => ({
    getClient: vi.fn().mockReturnValue({
      archiveWorkspace: vi.fn().mockResolvedValue({ error: null }),
    }),
  }),
}));

vi.mock("@/stores/navigation-active-workspace-store", () => ({
  useActiveWorkspaceSelection: () => ({
    serverId: "server-1",
    workspaceId: "chat-1",
  }),
}));

function createChatEntry(id: string, name: string): SidebarWorkspaceEntry {
  return {
    workspaceKey: `server-1:${id}`,
    serverId: "server-1",
    workspaceId: id,
    name,
    workspaceKind: "chat",
    projectName: "Chats",
    projectId: "__chats__",
    projectDisplayName: "Chats",
    cwd: `/tmp/chats/${id}`,
    workspaceDirectory: `/tmp/chats/${id}`,
    status: "idle",
    hasUnread: false,
    archivingAt: null,
    isHiding: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as SidebarWorkspaceEntry;
}

const defaultRenderWorkspaceItem = (entry: SidebarWorkspaceEntry) => (
  <div key={entry.workspaceKey} data-testid={`chat-item-${entry.workspaceId}`}>
    {entry.name}
  </div>
);

describe("SidebarChatsSection", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function renderSection(props: Partial<React.ComponentProps<typeof SidebarChatsSection>> = {}) {
    const defaultEntries = new Map<string, SidebarWorkspaceEntry>();
    act(() => {
      root.render(
        <SidebarChatsSection
          workspaceEntriesByKey={props.workspaceEntriesByKey ?? defaultEntries}
          activeWorkspaceSelection={props.activeWorkspaceSelection ?? null}
          creatingWorkspaceIds={props.creatingWorkspaceIds ?? new Set()}
          hostBadgeByServerId={props.hostBadgeByServerId ?? new Map()}
          supportsPinningByServerId={props.supportsPinningByServerId ?? new Map()}
          onToggleWorkspacePin={props.onToggleWorkspacePin ?? vi.fn()}
          showShortcutBadges={props.showShortcutBadges ?? false}
          shortcutIndexByWorkspaceKey={props.shortcutIndexByWorkspaceKey ?? new Map()}
          selectionEnabled={props.selectionEnabled ?? true}
          renderWorkspaceItem={props.renderWorkspaceItem ?? defaultRenderWorkspaceItem}
          {...props}
        />,
      );
    });
  }

  it("does not render archive-all button when there are no chat entries", () => {
    renderSection({ workspaceEntriesByKey: new Map() });

    expect(container.querySelector('[data-testid="sidebar-chats-archive-all-button"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-chats-new-button"]')).not.toBeNull();
  });

  it("renders archive-all button next to new chat button when chats exist", () => {
    const chat1 = createChatEntry("chat-1", "Chat 1");
    const chat2 = createChatEntry("chat-2", "Chat 2");
    const entries = new Map([
      [chat1.workspaceKey, chat1],
      [chat2.workspaceKey, chat2],
    ]);

    renderSection({ workspaceEntriesByKey: entries });

    expect(
      container.querySelector('[data-testid="sidebar-chats-archive-all-button"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="sidebar-chats-new-button"]')).not.toBeNull();
  });

  it("prompts confirmation and does not archive if user cancels", async () => {
    vi.mocked(confirmDialog).mockResolvedValue(false);

    const chat1 = createChatEntry("chat-1", "Chat 1");
    const entries = new Map([[chat1.workspaceKey, chat1]]);

    renderSection({ workspaceEntriesByKey: entries });

    const archiveAllBtn = container.querySelector(
      '[data-testid="sidebar-chats-archive-all-button"]',
    ) as HTMLButtonElement;
    expect(archiveAllBtn).not.toBeNull();

    await act(async () => {
      archiveAllBtn.click();
    });

    expect(confirmDialog).toHaveBeenCalledTimes(1);
    expect(confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        destructive: true,
      }),
    );
    expect(archiveWorkspacesOptimistically).not.toHaveBeenCalled();
  });

  it("archives all chat entries and redirects active workspace if confirmed", async () => {
    vi.mocked(confirmDialog).mockResolvedValue(true);
    vi.mocked(archiveWorkspacesOptimistically).mockResolvedValue([]);
    const purgeSpy = vi.spyOn(useWorkspaceLayoutStore.getState(), "purgeWorkspace");

    const chat1 = createChatEntry("chat-1", "Chat 1");
    const chat2 = createChatEntry("chat-2", "Chat 2");
    const entries = new Map([
      [chat1.workspaceKey, chat1],
      [chat2.workspaceKey, chat2],
    ]);

    renderSection({
      workspaceEntriesByKey: entries,
      activeWorkspaceSelection: { serverId: "server-1", workspaceId: "chat-1" },
    });

    const archiveAllBtn = container.querySelector(
      '[data-testid="sidebar-chats-archive-all-button"]',
    ) as HTMLButtonElement;
    expect(archiveAllBtn).not.toBeNull();

    await act(async () => {
      archiveAllBtn.click();
    });

    expect(confirmDialog).toHaveBeenCalledTimes(1);
    expect(redirectIfArchivingActiveWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: "server-1",
        workspaceId: "chat-1",
      }),
    );
    expect(purgeSpy).toHaveBeenCalledWith("server-1:chat-1");
    expect(purgeSpy).toHaveBeenCalledWith("server-1:chat-2");
    expect(archiveWorkspacesOptimistically).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaces: [
          { serverId: "server-1", workspaceId: "chat-1" },
          { serverId: "server-1", workspaceId: "chat-2" },
        ],
      }),
    );
  });

  it("shows error toast if archiving fails", async () => {
    vi.mocked(confirmDialog).mockResolvedValue(true);
    vi.mocked(archiveWorkspacesOptimistically).mockResolvedValue([
      { serverId: "server-1", workspaceId: "chat-1", error: new Error("Network error") },
    ]);

    const chat1 = createChatEntry("chat-1", "Chat 1");
    const entries = new Map([[chat1.workspaceKey, chat1]]);

    renderSection({ workspaceEntriesByKey: entries });

    const archiveAllBtn = container.querySelector(
      '[data-testid="sidebar-chats-archive-all-button"]',
    ) as HTMLButtonElement;
    expect(archiveAllBtn).not.toBeNull();

    await act(async () => {
      archiveAllBtn.click();
    });

    expect(mockToast.error).toHaveBeenCalled();
  });
});
