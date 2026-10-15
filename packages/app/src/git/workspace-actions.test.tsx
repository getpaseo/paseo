/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { i18n as testI18n } from "@/i18n/i18next";
import type { GitAction, GitActions, WorkspaceWorkflowState } from "@/git/policy";
import { WorkspaceActions } from "@/git/workspace-actions";

void testI18n;

const mocks = vi.hoisted(() => ({
  useGitActions: vi.fn(),
  runGitAction: vi.fn(),
  launch: vi.fn(),
  toastError: vi.fn(),
  client: { listProviderFeatures: vi.fn() },
}));

vi.mock("@/git/use-actions", () => ({
  useGitActions: mocks.useGitActions,
  useGitActionRunner: () => mocks.runGitAction,
}));

vi.mock("lucide-react-native", () => ({
  Eye: () => null,
  GitCommitHorizontal: () => null,
  GitPullRequest: () => null,
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: { create: () => ({}) },
  withUnistyles: (component: React.ComponentType) => component,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipContent: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/git/workflow/launch", () => ({
  launchWorkspaceWorkflowAction: mocks.launch,
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => mocks.client,
}));

vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ error: mocks.toastError }),
}));

vi.mock("expo-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock("@/agent-profiles", () => ({ useAgentProfiles: () => ({ profiles: [] }) }));

vi.mock("@/hooks/use-daemon-config", () => ({
  useDaemonConfig: () => ({
    config: { workspaceGitWorkflow: { prModel: { provider: "codex", model: "pr" } } },
  }),
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({
      sessions: {
        host: { serverInfo: { features: { workspaceGitWorkflow: true } } },
      },
    }),
}));

vi.mock("@/utils/host-routes", () => ({
  buildSettingsHostSectionRoute: () => "/settings",
}));

vi.mock("@/git/action-icons", () => ({ GIT_ACTION_ICONS: {} }));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onPress,
    disabled,
    loading,
    testID,
  }: {
    children?: React.ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    loading?: boolean;
    testID?: string;
  }) => (
    <button
      type="button"
      data-testid={testID}
      data-loading={loading ? "true" : "false"}
      disabled={disabled}
      onClick={onPress}
    >
      {children}
    </button>
  ),
}));

function gitAction(overrides: Partial<GitAction> & Pick<GitAction, "id">): GitAction {
  return {
    label: overrides.id,
    pendingLabel: overrides.id,
    successLabel: overrides.id,
    disabled: false,
    status: "idle",
    startsGroup: false,
    handler: vi.fn(),
    ...overrides,
  };
}

function useScenario(workflowState: WorkspaceWorkflowState, actions: GitAction[] = []): void {
  const gitActions: GitActions = {
    primary: actions[0] ?? null,
    secondary: actions.slice(1),
    menu: [],
  };
  mocks.useGitActions.mockReturnValue({
    gitActions,
    commitAction: gitAction({ id: "commit" }),
    workflowState,
    workflowContext: {
      cwd: "/repo",
      baseRef: "origin/paseo-local",
      branch: "feature",
      pullRequestUrl: "https://example.com/pr/8",
    },
    branchLabel: "feature",
    isGit: true,
  });
}

function render(): { unmount: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<WorkspaceActions serverId="host" workspaceId="ws" cwd="/repo" />);
  });
  return {
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function primaryCta(): HTMLButtonElement {
  const button = document.querySelector('[data-testid="changes-primary-cta"]');
  if (!(button instanceof HTMLButtonElement)) throw new Error("Missing primary CTA");
  return button;
}

describe("WorkspaceActions", () => {
  let current: ReturnType<typeof render> | null = null;

  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    document.body.innerHTML = "";
    mocks.useGitActions.mockReset();
    mocks.runGitAction.mockReset();
    mocks.launch.mockReset();
    mocks.launch.mockResolvedValue({ draftId: "draft", clientMessageId: "message" });
    mocks.toastError.mockReset();
  });

  afterEach(() => {
    current?.unmount();
    current = null;
    vi.unstubAllGlobals();
  });

  it.each([
    ["create-pr", { action: "create-pr" }, "Create PR"],
    ["commit-and-push", { action: "commit-and-push" }, "Commit & push"],
    ["repair-checks", { action: "repair-checks", nativeActionId: "pr" }, "Resolve failures"],
    ["merge", { action: "merge", nativeActionId: "merge-pr-squash" }, "Merge"],
    ["view-pr", { action: "view-pr", nativeActionId: "pr" }, "View PR"],
    ["archive", { action: "archive", nativeActionId: "archive-workspace" }, "Archive workspace"],
    ["checking", { action: "checking", reason: "status-unavailable" }, "Checking status..."],
    [
      "unavailable",
      { action: "unavailable", reason: "pull-request-blocked" },
      "Status unavailable",
    ],
  ] as const)("labels the primary CTA for %s", (_name, workflowState, expected) => {
    useScenario(workflowState as WorkspaceWorkflowState);
    current = render();

    expect(primaryCta().textContent).toBe(expected);
  });

  it("launches local check repair and shows View PR beside it", () => {
    const prAction = gitAction({ id: "pr", label: "View PR" });
    useScenario({ action: "repair-checks", nativeActionId: "pr" }, [prAction]);
    current = render();

    const viewPr = document.querySelector('[data-testid="workspace-git-view-pr"]');
    expect(viewPr?.textContent).toBe("View PR");
    expect(primaryCta().textContent).toBe("Resolve failures");

    fireEvent.click(primaryCta());
    expect(mocks.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "repair-checks",
        branch: "feature",
        prUrl: "https://example.com/pr/8",
      }),
    );

    fireEvent.click(viewPr as HTMLButtonElement);
    expect(mocks.runGitAction).toHaveBeenCalledWith(prAction);
  });

  it.each([
    ["create-pr", { action: "create-pr" }],
    ["commit-and-push", { action: "commit-and-push" }],
  ] as const)("launches %s from the primary CTA", (action, workflowState) => {
    useScenario(workflowState as WorkspaceWorkflowState);
    current = render();

    fireEvent.click(primaryCta());
    expect(mocks.launch).toHaveBeenCalledWith(expect.objectContaining({ action }));
  });

  it("runs the native merge action from the primary CTA", () => {
    const mergeAction = gitAction({ id: "merge-pr-squash" });
    useScenario({ action: "merge", nativeActionId: "merge-pr-squash" }, [mergeAction]);
    current = render();

    fireEvent.click(primaryCta());
    expect(mocks.runGitAction).toHaveBeenCalledWith(mergeAction);
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("hides the View PR button outside repair-checks", () => {
    const prAction = gitAction({ id: "pr" });
    useScenario({ action: "view-pr", nativeActionId: "pr" }, [prAction]);
    current = render();

    expect(document.querySelector('[data-testid="workspace-git-view-pr"]')).toBeNull();
  });

  it("blocks duplicate launches while preparation is pending", async () => {
    let finish: (() => void) | null = null;
    mocks.launch.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    useScenario({ action: "create-pr" });
    current = render();

    fireEvent.click(primaryCta());
    fireEvent.click(primaryCta());

    expect(mocks.launch).toHaveBeenCalledTimes(1);
    expect(primaryCta().disabled).toBe(true);
    expect(primaryCta().dataset.loading).toBe("true");
    await act(async () => finish?.());
    expect(primaryCta().disabled).toBe(false);
  });

  it("shows launch errors and releases the pending state", async () => {
    mocks.launch.mockRejectedValue(new Error("Feature discovery failed"));
    useScenario({ action: "create-pr" });
    current = render();

    fireEvent.click(primaryCta());
    await act(async () => Promise.resolve());

    expect(mocks.toastError).toHaveBeenCalledWith("Feature discovery failed");
    expect(primaryCta().disabled).toBe(false);
  });
});
