/**
 * @vitest-environment jsdom
 */
import React, { type ReactElement } from "react";
import { act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import type { CheckoutStatusResponse } from "@server/shared/messages";
import { WorkspaceOpenInEditorButton } from "./workspace-open-in-editor-button";

type CheckoutStatusPayload = CheckoutStatusResponse["payload"];
type CheckoutStatusQueryResult = {
  status: CheckoutStatusPayload | null;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  error: Error | null;
};

const {
  theme,
  mockClient,
  openExternalUrlMock,
  updatePreferredEditorMock,
  toastErrorMock,
  preferredEditorState,
  checkoutStatusState,
} = vi.hoisted(() => {
  const theme = {
    spacing: { 1: 4, 2: 8, 3: 12 },
    borderWidth: { 1: 1 },
    borderRadius: { md: 6 },
    fontSize: { sm: 13 },
    fontWeight: { normal: "400" },
    colors: {
      foreground: "#fff",
      foregroundMuted: "#aaa",
      surface2: "#222",
      borderAccent: "#444",
    },
  };

  const mockClient = {
    listAvailableEditors: vi.fn(async () => ({
      error: null,
      editors: [{ id: "vscode", label: "VS Code" }],
    })),
    openInEditor: vi.fn(async () => ({ error: null })),
  };

  return {
    theme,
    mockClient,
    openExternalUrlMock: vi.fn(async () => undefined),
    updatePreferredEditorMock: vi.fn(async () => undefined),
    toastErrorMock: vi.fn(),
    preferredEditorState: { current: "github" as string | null },
    checkoutStatusState: {
      current: {
        status: null,
        isLoading: false,
        isFetching: false,
        isError: false,
        error: null,
      } as CheckoutStatusQueryResult,
    },
  };
});

vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
});

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
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

vi.mock("@/constants/platform", () => ({
  isNative: false,
  isWeb: true,
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => mockClient,
  useHostRuntimeIsConnected: () => true,
}));

vi.mock("@/hooks/use-preferred-editor", () => ({
  resolvePreferredEditorId: (
    availableEditorIds: readonly string[],
    storedEditorId: string | null | undefined,
  ) => {
    if (storedEditorId && availableEditorIds.some((editorId) => editorId === storedEditorId)) {
      return storedEditorId;
    }
    return availableEditorIds[0] ?? null;
  },
  usePreferredEditor: () => ({
    preferredEditorId: preferredEditorState.current,
    updatePreferredEditor: updatePreferredEditorMock,
  }),
}));

vi.mock("@/hooks/use-checkout-status-query", () => ({
  useCheckoutStatusQuery: () => checkoutStatusState.current,
}));

vi.mock("@/utils/open-external-url", () => ({
  openExternalUrl: openExternalUrlMock,
}));

vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ error: toastErrorMock }),
}));

vi.mock("@/components/icons/editor-app-icons", () => ({
  EditorAppIcon: ({ editorId }: { editorId: string }) => (
    <span data-testid={`editor-target-icon-${editorId}`} />
  ),
}));

vi.mock("@/components/icons/github-icon", () => ({
  GitHubIcon: () => <span data-testid="github-target-icon" />,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children, testID }: { children: React.ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    leading,
    trailing,
    onSelect,
    testID,
  }: {
    children: React.ReactNode;
    leading?: React.ReactNode;
    trailing?: React.ReactNode;
    onSelect?: () => void;
    testID?: string;
  }) => (
    <button type="button" data-testid={testID} onClick={onSelect}>
      {leading}
      {children}
      {trailing}
    </button>
  ),
  DropdownMenuTrigger: ({
    children,
    testID,
  }: {
    children:
      | React.ReactNode
      | ((state: { hovered: boolean; pressed: boolean; open: boolean }) => React.ReactNode);
    testID?: string;
  }) => (
    <button type="button" data-testid={testID}>
      {typeof children === "function"
        ? children({ hovered: false, pressed: false, open: true })
        : children}
    </button>
  ),
}));

vi.mock("lucide-react-native", () => {
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    React.createElement("span", { "data-icon": name, ...props });
  return {
    Check: createIcon("Check"),
    ChevronDown: createIcon("ChevronDown"),
  };
});

vi.mock("react-native", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("react-native");
  return actual;
});

function createCheckoutStatus(
  overrides: Partial<CheckoutStatusPayload> = {},
): CheckoutStatusPayload {
  return {
    cwd: "/repo",
    error: null,
    requestId: "checkout-status-1",
    isGit: true,
    isPaseoOwnedWorktree: false,
    repoRoot: "/repo",
    currentBranch: "feature/workspace-button",
    isDirty: false,
    baseRef: "origin/main",
    aheadBehind: { ahead: 0, behind: 0 },
    aheadOfOrigin: 0,
    behindOfOrigin: 0,
    hasRemote: true,
    remoteUrl: "git@github.com:acme/repo.git",
    ...overrides,
  } as CheckoutStatusPayload;
}

function renderButton(): { unmount: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  function element(): ReactElement {
    return (
      <QueryClientProvider client={queryClient}>
        <WorkspaceOpenInEditorButton serverId="server-1" cwd="/repo" />
      </QueryClientProvider>
    );
  }

  act(() => {
    root.render(element());
  });

  return {
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function queryByTestId(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
}

async function waitForExpectation(assertion: () => void): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  throw lastError;
}

describe("WorkspaceOpenInEditorButton", () => {
  let current: ReturnType<typeof renderButton> | null = null;

  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    document.body.innerHTML = "";

    preferredEditorState.current = "github";
    checkoutStatusState.current = {
      status: createCheckoutStatus(),
      isLoading: false,
      isFetching: false,
      isError: false,
      error: null,
    };

    mockClient.listAvailableEditors.mockClear();
    mockClient.openInEditor.mockClear();
    openExternalUrlMock.mockClear();
    updatePreferredEditorMock.mockClear();
    toastErrorMock.mockClear();
  });

  afterEach(() => {
    current?.unmount();
    current = null;
    vi.unstubAllGlobals();
  });

  it("opens the current GitHub branch from the primary action when GitHub is preferred", async () => {
    current = renderButton();

    await waitForExpectation(() => {
      const primary = queryByTestId("workspace-open-in-editor-primary");
      expect(primary).toBeTruthy();
      expect(primary?.getAttribute("aria-label")).toBe("Open workspace in GitHub");
    });

    const primary = queryByTestId("workspace-open-in-editor-primary");
    if (!(primary instanceof HTMLElement)) {
      throw new Error("Missing primary button");
    }

    click(primary);
    await act(async () => {
      await Promise.resolve();
    });

    expect(openExternalUrlMock).toHaveBeenCalledWith(
      "https://github.com/acme/repo/tree/feature/workspace-button",
    );
    expect(mockClient.openInEditor).not.toHaveBeenCalled();
    expect(updatePreferredEditorMock).toHaveBeenCalledWith("github");
  });

  it("falls back to the first local editor when the GitHub target is unavailable", async () => {
    checkoutStatusState.current = {
      status: createCheckoutStatus({
        remoteUrl: "git@gitlab.com:acme/repo.git",
      }),
      isLoading: false,
      isFetching: false,
      isError: false,
      error: null,
    };

    current = renderButton();

    await waitForExpectation(() => {
      const primary = queryByTestId("workspace-open-in-editor-primary");
      expect(primary).toBeTruthy();
      expect(primary?.getAttribute("aria-label")).toBe("Open workspace in VS Code");
    });

    expect(queryByTestId("workspace-open-in-editor-item-github")).toBeNull();
  });
});
