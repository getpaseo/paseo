/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitAction, GitActions } from "@/git/policy";
import type { PrPaneData } from "./data";

// pane.tsx uses the classic JSX runtime at module scope, which references a
// global `React`. Stub it before the static import below evaluates.
vi.hoisted(async () => {
  const ReactModule = await import("react");
  (globalThis as Record<string, unknown>).React = ReactModule.default ?? ReactModule;
});

const { theme, openExternalUrl, toast, sessionFeatures, refresh, getStatus } = vi.hoisted(() => ({
  theme: {
    spacing: { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16 },
    fontSize: { xs: 11, sm: 13, base: 15 },
    fontWeight: { normal: "400" as const, medium: "500" as const },
    borderRadius: { sm: 4, md: 6, lg: 8, full: 999 },
    fontFamily: { mono: "monospace" },
    colors: {
      surface1: "#111",
      surface2: "#222",
      surfaceSidebar: "#0a0a0a",
      surfaceSidebarHover: "#1a1a1a",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      border: "#444",
      statusSuccess: "#22c55e",
      statusDanger: "#ef4444",
      statusWarning: "#eab308",
      statusMerged: "#a855f7",
    },
  },
  openExternalUrl: vi.fn().mockResolvedValue(undefined),
  toast: { show: vi.fn(), error: vi.fn(), success: vi.fn() },
  sessionFeatures: { current: {} as Record<string, boolean> },
  refresh: vi.fn().mockResolvedValue(undefined),
  getStatus: vi.fn(() => "idle" as const),
}));

vi.mock("react-native", () => {
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
      "div",
      {
        role: accessibilityRole,
        "aria-label": accessibilityLabel,
        "data-testid": testID,
        "data-disabled": disabled ? "true" : undefined,
        onClick:
          onPress && !disabled
            ? (event: React.MouseEvent) =>
                onPress({ stopPropagation: () => event.stopPropagation() })
            : undefined,
        ...dataAttrs,
      },
      typeof children === "function" ? children({ pressed: false, hovered: false }) : children,
    );
  };

  return {
    View: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
      React.createElement("div", { "data-testid": testID }, children),
    Text: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
      React.createElement("span", { "data-testid": testID }, children),
    Pressable: passthrough,
    ScrollView: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", null, children),
    Image: ({ source }: { source?: { uri?: string } }) =>
      React.createElement("img", { src: source?.uri ?? "" }),
    Platform: { OS: "web" },
  };
});

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (t: typeof theme) => unknown)(theme) : factory,
  },
  withUnistyles: (Component: unknown) => Component,
  useUnistyles: () => ({ theme }),
}));

vi.mock("lucide-react-native", () => {
  const icon = (name: string) => {
    const Icon = () => React.createElement("span", { "data-icon": name });
    Icon.displayName = name;
    return Icon;
  };
  return {
    ChevronDown: icon("ChevronDown"),
    ChevronRight: icon("ChevronRight"),
    CircleCheck: icon("CircleCheck"),
    CircleDot: icon("CircleDot"),
    CircleSlash: icon("CircleSlash"),
    CircleX: icon("CircleX"),
    Copy: icon("Copy"),
    ExternalLink: icon("ExternalLink"),
    GitMerge: icon("GitMerge"),
    GitPullRequest: icon("GitPullRequest"),
    GitPullRequestClosed: icon("GitPullRequestClosed"),
    GitPullRequestDraft: icon("GitPullRequestDraft"),
    MessageSquare: icon("MessageSquare"),
    MessageSquarePlus: icon("MessageSquarePlus"),
    MoreHorizontal: icon("MoreHorizontal"),
    RotateCw: icon("RotateCw"),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      if (key === "workspace.git.pr.actions.viewPullRequest") return "View Pull Request";
      if (key === "workspace.git.diff.refreshState") return "Refresh";
      if (key === "workspace.git.diff.refreshing") return "Refreshing";
      if (key === "workspace.git.diff.failedRefresh") return "Failed to refresh";
      return key;
    },
  }),
}));

vi.mock("@/utils/open-external-url", () => ({
  openExternalUrl,
}));

vi.mock("@/contexts/toast-context", () => ({
  useToast: () => toast,
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => null,
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({ sessions: { server: { serverInfo: { features: sessionFeatures.current } } } }),
}));

vi.mock("@/attachments/workspace-attachments-store", () => ({
  useWorkspaceAttachmentsStore: (selector: (state: unknown) => unknown) =>
    selector({ addWorkspaceAttachment: vi.fn() }),
}));

vi.mock("@/git/actions-store", () => ({
  useCheckoutGitActionsStore: (selector: (state: unknown) => unknown) =>
    selector({ refresh, getStatus }),
}));

vi.mock("@/git/actions-split-button", async () => {
  const ReactModule = await import("react");
  return {
    GitActionsSplitButton: ({ gitActions }: { gitActions: GitActions }) => {
      const primary = gitActions.primary;
      if (!primary) return null;
      return ReactModule.createElement(
        "button",
        {
          type: "button",
          "data-testid": "changes-primary-cta",
          disabled: primary.disabled || undefined,
          onClick: () => {
            if (primary.unavailableMessage) {
              toast.show(primary.unavailableMessage);
              return;
            }
            primary.handler();
          },
        },
        primary.label,
      );
    },
  };
});

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onPress,
    disabled,
    testID,
  }: {
    children?: React.ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    testID?: string;
  }) =>
    React.createElement(
      "button",
      {
        type: "button",
        "data-testid": testID,
        "data-disabled": disabled ? "true" : undefined,
        disabled: disabled || undefined,
        onClick: () => !disabled && onPress?.(),
      },
      children,
    ),
}));

vi.mock("@/components/ui/loading-spinner", () => ({
  LoadingSpinner: () => React.createElement("span", { "data-testid": "loading-spinner" }),
}));

vi.mock("@/components/ui/status-badge", () => ({
  StatusBadge: ({ label }: { label?: string }) => React.createElement("span", null, label),
}));

vi.mock("@/components/markdown/renderer", () => ({
  MarkdownRenderer: ({ text }: { text?: string }) => React.createElement("span", null, text),
}));

vi.mock("@/utils/rich-clipboard", () => ({
  writeMarkdownToRichClipboard: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/utils/rich-clipboard-default-environment", () => ({
  getDefaultMarkdownClipboardEnvironment: () => ({}),
}));

vi.mock("@/components/ui/dropdown-menu", () => {
  const passthrough = ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children);
  return {
    DropdownMenu: passthrough,
    DropdownMenuContent: passthrough,
    DropdownMenuItem: passthrough,
    DropdownMenuTrigger: passthrough,
  };
});

vi.mock("./activity-skeleton", () => ({
  PrActivitySkeleton: () =>
    React.createElement("div", { "data-testid": "pr-pane-activity-skeleton" }),
}));

import { PullRequestPane } from "./pane";

function prPaneData(overrides: Partial<PrPaneData> = {}): PrPaneData {
  return {
    provider: { id: "github", label: "GitHub" },
    number: 42,
    repoOwner: "acme",
    repoName: "app",
    title: "Add the thing",
    state: "open",
    url: "https://github.com/acme/app/pull/42",
    reviewDecision: "pending",
    awaitingReviewers: [],
    checks: [],
    activity: [],
    ...overrides,
  };
}

function mergeAction(overrides: Partial<GitAction> = {}): GitAction {
  return {
    id: "merge-pr-squash",
    label: "Squash and merge",
    pendingLabel: "Merging…",
    successLabel: "Merged",
    disabled: false,
    status: "idle",
    startsGroup: false,
    handler: vi.fn(),
    ...overrides,
  };
}

const emptyMergeActions: GitActions = { primary: null, secondary: [], menu: [] };

describe("PullRequestPane", () => {
  let container: HTMLElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    sessionFeatures.current = {};
    openExternalUrl.mockClear();
    toast.show.mockClear();
    refresh.mockClear();
    getStatus.mockReturnValue("idle");
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    root = null;
    container?.remove();
    container = null;
    vi.unstubAllGlobals();
  });

  function render(
    props: {
      data?: PrPaneData;
      activityLoading?: boolean;
      prMergeActions?: GitActions;
    } = {},
  ) {
    act(() => {
      root?.render(
        <PullRequestPane
          serverId="server"
          cwd="/repo"
          data={props.data ?? prPaneData()}
          activityLoading={props.activityLoading ?? false}
          prMergeActions={props.prMergeActions ?? emptyMergeActions}
          workspaceAttachmentScopeKey="scope"
        />,
      );
    });
  }

  function query(testID: string): HTMLElement | null {
    return container?.querySelector<HTMLElement>(`[data-testid="${testID}"]`) ?? null;
  }

  function click(element: Element | null): void {
    if (!element) throw new Error("Cannot click null element");
    act(() => {
      element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
  }

  describe("toolbar", () => {
    it("renders the toolbar with the View PR button", () => {
      render();
      expect(query("pr-pane-toolbar")).not.toBeNull();
      expect(query("pr-pane-view-pr")).not.toBeNull();
    });

    it("opens the PR url when View PR is pressed", () => {
      render({ data: prPaneData({ url: "https://github.com/acme/app/pull/7" }) });
      click(query("pr-pane-view-pr"));
      expect(openExternalUrl).toHaveBeenCalledWith("https://github.com/acme/app/pull/7");
    });

    it("hides the refresh button when checkoutRefresh is unsupported", () => {
      sessionFeatures.current = {};
      render();
      expect(query("pr-pane-refresh")).toBeNull();
    });

    it("shows the refresh button when checkoutRefresh is supported", () => {
      sessionFeatures.current = { checkoutRefresh: true };
      render();
      expect(query("pr-pane-refresh")).not.toBeNull();
    });
  });

  describe("merge control", () => {
    it("renders the split button and calls the handler when the primary action is ready", () => {
      const handler = vi.fn();
      render({
        prMergeActions: { primary: mergeAction({ handler }), secondary: [], menu: [] },
      });

      const cta = query("changes-primary-cta");
      expect(cta).not.toBeNull();

      click(cta);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(toast.show).not.toHaveBeenCalled();
    });

    it("omits the merge control when prMergeActions is empty", () => {
      render({ prMergeActions: emptyMergeActions });
      expect(query("changes-primary-cta")).toBeNull();
    });

    it("toasts the unavailable reason and does not run the handler for a muted action", () => {
      const handler = vi.fn();
      render({
        prMergeActions: {
          primary: mergeAction({ handler, unavailableMessage: "Checks are still running" }),
          secondary: [],
          menu: [],
        },
      });

      click(query("changes-primary-cta"));
      expect(handler).not.toHaveBeenCalled();
      expect(toast.show).toHaveBeenCalledWith("Checks are still running");
    });
  });

  describe("activity", () => {
    const activityEntry: PrPaneData["activity"][number] = {
      provider: "github",
      id: "comment-1",
      kind: "comment",
      author: "octocat",
      avatarColor: "#8b5cf6",
      body: "Looks good",
      age: "2h",
      url: "https://github.com/acme/app/pull/42#comment-1",
    };

    it("shows the skeleton and disables Add all to chat while loading", () => {
      render({
        data: prPaneData({ activity: [activityEntry] }),
        activityLoading: true,
      });

      expect(query("pr-pane-activity-skeleton")).not.toBeNull();
      expect(container?.textContent).not.toContain("No activity yet");

      const addAll = container?.querySelector<HTMLButtonElement>("button[data-disabled='true']");
      expect(addAll?.textContent).toContain("Add all to chat");
    });

    it("shows the empty state and hides the skeleton once loaded with no activity", () => {
      render({ data: prPaneData({ activity: [] }), activityLoading: false });

      expect(query("pr-pane-activity-skeleton")).toBeNull();
      expect(container?.textContent).toContain("No activity yet");
    });
  });
});
