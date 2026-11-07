/** @vitest-environment jsdom */
import { ToastApiProvider } from "@/contexts/toast-api-context";
import { act, useCallback, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { waitFor } from "@testing-library/dom";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const noop = () => {};
const toastApi = { show: () => noop, error: noop, copied: noop };
const roots: ReturnType<typeof createRoot>[] = [];
function render(children: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(children));
  return {
    rerender: (next: ReactNode) => act(() => root.render(next)),
    unmount: () => act(() => root.unmount()),
  };
}
function cleanup() {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
}

import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it } from "vitest";
import { RetainedPanelActivity } from "@/components/retained-panel";
import {
  PullRequestConnectionProvider,
  type PullRequestConnection,
} from "@/git/pull-request-connection";
import { usePullRequestPanelDescriptor } from "./descriptor";
import { useRetainedPullRequestData } from "./data";
import { useWorkspacePullRequestDiscovery } from "./discovery";
import { useSessionStore } from "@/stores/session-store";
import { collectAllTabs, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
const serverId = "pr-demand",
  workspaceId = "workspace",
  workspaceKey = `${serverId}:${workspaceId}`,
  cwd = "/repo";
function Content() {
  const data = useRetainedPullRequestData({ serverId, cwd }, "content");
  return <span data-testid="content">{data.data?.title}</span>;
}
function Rail() {
  const descriptor = usePullRequestPanelDescriptor(
    { kind: "pull_request" },
    { serverId, workspaceId },
  );
  return <span>{descriptor.label}</span>;
}
function Discovery({ active, workspaceActive }: { active: boolean; workspaceActive: boolean }) {
  useWorkspacePullRequestDiscovery({
    workspaceKey,
    serverId,
    cwd,
    workspaceActive,
    isGit: true,
    layoutMode: "single-pane",
    explorerOpen: active,
  });
  return null;
}
function createSource() {
  const calls = { status: 0, timeline: 0 };
  const client: NonNullable<PullRequestConnection["client"]> = {
    async checkoutPrStatus() {
      calls.status++;
      return {
        cwd,
        forge: "github",
        requestId: "status",
        error: null,
        githubFeaturesEnabled: true,
        status: {
          forge: "github",
          number: 42,
          url: "https://github.com/acme/repo/pull/42",
          title: "Retained PR",
          state: "open",
          baseRefName: "main",
          headRefName: "feature",
          isMerged: false,
          isDraft: false,
          mergeable: "UNKNOWN",
          checks: [],
          reviewDecision: null,
          repoOwner: "acme",
          repoName: "repo",
        },
      };
    },
    async pullRequestTimeline() {
      calls.timeline++;
      return {
        cwd,
        requestId: "timeline",
        prNumber: 42,
        items: [],
        truncated: false,
        error: null,
        githubFeaturesEnabled: true,
      };
    },
  };
  return { client, calls };
}
beforeEach(async () => {
  useSessionStore.getState().initializeSession(serverId, null);
  useSessionStore.getState().setWorkspaces(
    serverId,
    new Map([
      [
        workspaceId,
        {
          id: workspaceId,
          projectId: "project",
          projectDisplayName: "Project",
          projectCustomName: null,
          projectRootPath: cwd,
          workspaceDirectory: cwd,
          projectKind: "git",
          workspaceKind: "local_checkout",
          name: "main",
          status: "done",
          createdAt: null,
          lastUserMessageAt: null,
          statusEnteredAt: null,
          archivingAt: null,
          diffStat: null,
          scripts: [],
        },
      ],
    ]),
  );
  await useWorkspaceLayoutStore.persist.rehydrate();
  useWorkspaceLayoutStore.setState({
    layoutMode: "single-pane",
    layoutByWorkspace: {},
    explorerSidebarPaneIdByWorkspace: {},
  });
});
afterEach(() => {
  cleanup();
  useSessionStore.getState().clearSession(serverId);
  onlineManager.setOnline(true);
});
it("runs real PR descriptor/content/discovery hooks through hidden invalidation, reconnect and close opt-out", async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const source = createSource();
  useWorkspaceLayoutStore
    .getState()
    .openTab({ workspaceKey, target: { kind: "files" }, intent: "reveal" });
  function Tree({
    surface,
    content,
    otherRail = false,
    connected = true,
    workspaceActive = true,
  }: {
    surface: boolean;
    content: boolean;
    otherRail?: boolean;
    connected?: boolean;
    workspaceActive?: boolean;
  }) {
    const connection = useCallback(
      () => ({ client: source.client, isConnected: connected }),
      [connected],
    );
    return (
      <QueryClientProvider client={queryClient}>
        <PullRequestConnectionProvider connection={connection}>
          <ToastApiProvider api={toastApi}>
            <Discovery active={surface} workspaceActive={workspaceActive} />
          </ToastApiProvider>
          <RetainedPanelActivity active={surface && workspaceActive}>
            <Rail />
            <RetainedPanelActivity active={content}>
              <Content />
            </RetainedPanelActivity>
          </RetainedPanelActivity>
          {otherRail ? <Rail /> : null}
        </PullRequestConnectionProvider>
      </QueryClientProvider>
    );
  }
  const tabs = () =>
    collectAllTabs(useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root);
  const view = render(<Tree surface={false} content={false} />);
  expect(source.calls).toEqual({ status: 0, timeline: 0 });
  view.rerender(<Tree surface={true} content={false} />);
  await waitFor(() => expect(source.calls).toEqual({ status: 1, timeline: 0 }));
  await waitFor(() => expect(tabs().some((tab) => tab.target.kind === "pull_request")).toBe(true));
  expect(useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].focusedPaneId).toBe(
    "main",
  );
  view.rerender(<Tree surface={true} content={true} />);
  await waitFor(() => expect(source.calls).toEqual({ status: 1, timeline: 1 }));
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  await waitFor(() =>
    expect(document.querySelector('[data-testid="content"]')?.textContent).toBe("Retained PR"),
  );
  const cached = queryClient
    .getQueryCache()
    .getAll()
    .map((query) => query.state.data);
  view.rerender(<Tree surface={false} content={false} connected={false} />);
  await act(async () => {
    onlineManager.setOnline(false);
    await queryClient.invalidateQueries();
    onlineManager.setOnline(true);
  });
  view.rerender(<Tree surface={false} content={false} />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  expect(source.calls).toEqual({ status: 1, timeline: 1 });
  expect(
    queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.state.data),
  ).toEqual(cached);
  view.rerender(<Tree surface={false} content={false} otherRail />);
  await waitFor(() => expect(source.calls).toEqual({ status: 2, timeline: 1 }));
  view.rerender(<Tree surface={true} content={true} />);
  await waitFor(() => expect(source.calls).toEqual({ status: 2, timeline: 2 }));
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  const prTab = tabs().find((tab) => tab.target.kind === "pull_request")!;
  act(() => useWorkspaceLayoutStore.getState().closeTab(workspaceKey, prTab.tabId));
  view.rerender(<Tree surface={false} content={false} />);
  await act(async () => {
    await queryClient.invalidateQueries();
  });
  view.rerender(<Tree surface={true} content={false} />);
  await waitFor(() => expect(source.calls).toEqual({ status: 3, timeline: 2 }));
  expect(tabs().some((tab) => tab.target.kind === "pull_request")).toBe(false);
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  view.rerender(<Tree surface content workspaceActive={false} />);
  await act(async () => {
    await queryClient.invalidateQueries();
  });
  expect(source.calls).toEqual({ status: 3, timeline: 2 });
  view.rerender(<Tree surface content />);
  await waitFor(() => expect(source.calls).toEqual({ status: 4, timeline: 3 }));
  expect(tabs().some((tab) => tab.target.kind === "pull_request")).toBe(false);
  view.unmount();
  queryClient.clear();
});
