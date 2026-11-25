import React, { act, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { page } from "vitest/browser";
import { View } from "react-native";
import { ComposerTrackBar } from "@/composer/tracks";
import { MobilePanelsProvider } from "@/mobile-panels/provider";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { getHostRuntimeStore, type HostRuntimeSnapshot } from "@/runtime/host-runtime";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import {
  agent as agentFixture,
  workspace as workspaceFixture,
} from "@/plugins/client-state/fixtures";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/dom";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import { ToastApiProvider } from "@/contexts/toast-context";
import type { ToastApi } from "@/components/toast-host";
import type { PrPaneCheck, PrPaneData } from "./data";
import { PullRequestPane } from "./pane";
import { ComposerPrWatch } from "./composer-watch";
import { createBackgroundWorkModel } from "@/background-work/model";
import { checkoutPrStatusQueryKey, checkoutStatusQueryKey } from "@/git/query-keys";
import { WorkspaceActions } from "@/git/workspace-actions";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

const PANE_HEIGHT = 600;
const FILL_STYLE = { flex: 1 } as const;

const silentToasts: ToastApi = {
  show: () => () => {},
  copied: () => {},
  error: () => {},
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

function successfulChecks(count: number): PrPaneCheck[] {
  return Array.from({ length: count }, (_, index) => ({
    provider: "github",
    name: `check-${index + 1}`,
    status: "success",
    url: `https://example.test/checks/${index + 1}`,
  }));
}

function pullRequest(checks: PrPaneCheck[]): PrPaneData {
  return {
    provider: { id: "github", label: "GitHub" },
    forge: "github",
    number: 42,
    repoOwner: "acme",
    repoName: "widgets",
    title: "Ship the widget",
    state: "open",
    url: "https://example.test/pull/42",
    reviewDecision: "pending",
    awaitingReviewers: [],
    checks,
    activity: [],
  };
}

/** A phone's home indicator: the pane clears it with bottom padding. */
const HOME_INDICATOR_INSETS = { top: 0, right: 0, bottom: 34, left: 0 };

const NO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

function renderFixture(children: ReactNode, insets = NO_INSETS) {
  act(() =>
    root?.render(
      <SafeAreaInsetsContext.Provider value={insets}>
        <ToastApiProvider api={silentToasts}>
          <GestureHandlerRootView style={FILL_STYLE}>
            <BottomSheetModalProvider>{children}</BottomSheetModalProvider>
          </GestureHandlerRootView>
        </ToastApiProvider>
      </SafeAreaInsetsContext.Provider>,
    ),
  );
}

function renderPane(data: PrPaneData, insets = NO_INSETS, workspaceId?: string) {
  renderFixture(
    <PullRequestPane
      serverId="server-1"
      workspaceId={workspaceId}
      cwd="/repo"
      data={data}
      activityLoading={false}
    />,
    insets,
  );
}

function mountFixture() {
  container = document.createElement("div");
  container.style.height = `${PANE_HEIGHT}px`;
  container.style.width = "600px";
  container.style.maxWidth = "100%";
  container.style.display = "flex";
  container.style.flexDirection = "column";
  document.body.appendChild(container);
  root = createRoot(container);
  return container;
}

function mountPane(data: PrPaneData, insets = NO_INSETS, workspaceId?: string) {
  const fixture = mountFixture();
  renderPane(data, insets, workspaceId);
  const pane = fixture.querySelector<HTMLElement>('[data-testid="pr-pane"]');
  if (!pane) throw new Error("The pull request pane did not render");
  return pane;
}

/** The pressable row holding the Activity title. */
function activityHeader(pane: HTMLElement): HTMLElement {
  const title = within(pane).getByText(i18n.t("workspace.git.pr.sections.activity"));
  const header = title.closest<HTMLElement>("[tabindex]");
  if (!header) throw new Error("The Activity title is not inside a pressable header");
  return header;
}

function checksRegionBottom(pane: HTMLElement): number {
  return within(pane).getByRole("separator").getBoundingClientRect().top;
}

/** Whether a user sees the element: no scroll container clips it out of view. */
function isOnScreen(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  const hit = document.elementFromPoint(rect.left + 8, rect.top + rect.height / 2);
  return hit !== null && element.contains(hit);
}

/** React Native Web reports layout from a ResizeObserver, a frame or two after mounting. */
async function settleLayout() {
  for (let frame = 0; frame < 2; frame++) {
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  }
}

/** Drags the separator through each offset from where it starts, releasing at the last one. */
function dragSeparator(pane: HTMLElement, ...deltasY: number[]) {
  const separator = within(pane).getByRole("separator");
  const rect = separator.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const startY = rect.top + rect.height / 2;
  const pointer = { pointerId: 1, bubbles: true, cancelable: true, clientX: x, button: 0 };
  act(() => {
    separator.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, clientY: startY }));
  });
  for (const deltaY of deltasY) {
    act(() => {
      window.dispatchEvent(
        new PointerEvent("pointermove", { ...pointer, clientY: startY + deltaY }),
      );
    });
  }
  const endY = startY + (deltasY.at(-1) ?? 0);
  act(() => {
    window.dispatchEvent(new PointerEvent("pointerup", { ...pointer, clientY: endY }));
  });
}

describe("pull request pane layout", () => {
  it("docks a collapsed Activity section to the bottom and gives the checks the pane", async () => {
    const pane = mountPane(pullRequest(successfulChecks(10)));

    act(() => activityHeader(pane).click());

    await expect
      .poll(() => Math.round(activityHeader(pane).getBoundingClientRect().bottom))
      .toBe(Math.round(pane.getBoundingClientRect().bottom));
    const rows = within(pane).getAllByTestId("pr-pane-check-row");
    expect(rows).toHaveLength(10);
    expect(rows.every(isOnScreen)).toBe(true);
  });

  it("keeps keyboard focus on the Activity header while it collapses and expands", () => {
    const pane = mountPane(pullRequest(successfulChecks(3)));
    const header = activityHeader(pane);
    act(() => header.focus());

    act(() => header.click());
    expect(document.activeElement).toBe(header);
    act(() => header.click());
    expect(document.activeElement).toBe(header);
  });

  it("exposes whether Activity is expanded to assistive technology", () => {
    const pane = mountPane(pullRequest(successfulChecks(3)));
    expect(activityHeader(pane).getAttribute("aria-expanded")).toBe("true");

    act(() => activityHeader(pane).click());

    expect(activityHeader(pane).getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the Activity header inside the pane when a dragged pane gets short", async () => {
    const pane = mountPane(pullRequest(successfulChecks(30)));
    await settleLayout();
    dragSeparator(pane, PANE_HEIGHT);
    await settleLayout();

    act(() => {
      if (container) container.style.height = "160px";
    });
    await settleLayout();

    await expect
      .poll(() => activityHeader(pane).getBoundingClientRect().bottom)
      .toBeLessThanOrEqual(pane.getBoundingClientRect().bottom);
    expect(isOnScreen(activityHeader(pane))).toBe(true);
  });

  it.each([
    ["5px down", [5]],
    ["400px down", [400]],
    ["up past their end and back down", [-20, 100]],
  ])("gives the checks their earlier share when they grow after a drag %s", async (_name, path) => {
    const pane = mountPane(pullRequest(successfulChecks(2)));
    await settleLayout();
    const drawn = checksRegionBottom(pane);

    dragSeparator(pane, ...path);
    await settleLayout();
    expect(checksRegionBottom(pane)).toBeCloseTo(drawn, 0);

    renderPane(pullRequest(successfulChecks(30)));
    await settleLayout();
    const overview = within(pane).getByTestId("pr-pane-overview");
    expect(overview.getBoundingClientRect().height).toBeCloseTo(PANE_HEIGHT / 2, 0);
  });

  it("resizes the checks against Activity by dragging the separator between them", async () => {
    const pane = mountPane(pullRequest(successfulChecks(30)));
    await settleLayout();
    const before = checksRegionBottom(pane);

    dragSeparator(pane, 120);

    await expect.poll(() => Math.round(checksRegionBottom(pane) - before)).toBe(120);
    expect(activityHeader(pane).getBoundingClientRect().top).toBeGreaterThan(before + 100);
  });

  it("keeps the separator under the pointer when the pane clears a bottom inset", async () => {
    const pane = mountPane(pullRequest(successfulChecks(30)), HOME_INDICATOR_INSETS);
    await settleLayout();
    const before = checksRegionBottom(pane);

    dragSeparator(pane, 120);

    await expect.poll(() => Math.round(checksRegionBottom(pane) - before)).toBe(120);
  });
});

describe("Watch PR", () => {
  const serverId = "server-1";
  const workspaceId = "watch-tests";
  const pr = pullRequest([]);
  const agent = (id: string, fields: Partial<Agent> = {}): Agent => ({
    ...agentFixture,
    id,
    serverId,
    workspaceId,
    status: "idle",
    title: id,
    ...fields,
  });
  const subscribe =
    vi.fn<NonNullable<HostRuntimeSnapshot["client"]>["subscribeAgentChangeRequest"]>();

  function seedHost(agents: Agent[], supported = true, focusedId?: string) {
    subscribe.mockReset().mockResolvedValue(true);
    const runtime = getHostRuntimeStore();
    const snapshot = runtime.getSnapshot.bind(runtime);
    const client = new DaemonClient({ url: "ws://daemon.test", clientId: "watch-tests" });
    vi.spyOn(client, "subscribeAgentChangeRequest").mockImplementation(subscribe);
    const fixtureSnapshot: HostRuntimeSnapshot = {
      serverId,
      client,
      activeConnectionId: null,
      activeConnection: null,
      connectionStatus: "online",
      lastError: null,
      lastOnlineAt: null,
      agentDirectoryStatus: "ready",
      agentDirectoryError: null,
      hasEverLoadedAgentDirectory: true,
      probeByConnectionId: new Map(),
      clientGeneration: 1,
      connectionEpoch: 1,
    };
    vi.spyOn(runtime, "getSnapshot").mockImplementation((hostId) =>
      hostId === serverId ? fixtureSnapshot : snapshot(hostId),
    );
    const store = useSessionStore.getState();
    store.initializeSession(serverId, null);
    store.updateSessionServerInfo(serverId, {
      serverId,
      hostname: null,
      version: "0.17.4",
      features: supported ? { agentChangeRequestSubscribe: true } : {},
    });
    store.setAgents(serverId, new Map(agents.map((item) => [item.id, item])));
    store.setWorkspaces(
      serverId,
      new Map([
        [workspaceId, { ...workspaceFixture, id: workspaceId, workspaceDirectory: "/repo" }],
      ]),
    );
    const layout = useWorkspaceLayoutStore.getState();
    useWorkspaceLayoutStore.setState({ layoutByWorkspace: {} });
    if (focusedId) {
      layout.openTab({
        workspaceKey: `${serverId}:${workspaceId}`,
        target: { kind: "agent", agentId: focusedId },
        intent: "reveal",
      });
    }
  }

  function showPane(agents: Agent[], supported = true, focusedId?: string) {
    seedHost(agents, supported, focusedId);
    mountPane(pr, NO_INSETS, workspaceId);
  }

  function setupGitQueries() {
    const client = new QueryClient();
    client.setQueryData(checkoutPrStatusQueryKey(serverId, "/repo"), {
      githubFeaturesEnabled: true,
      status: { ...pr, mergeable: "UNKNOWN", checksStatus: "pending" },
      forge: "github",
    });
    client.setQueryData(checkoutStatusQueryKey(serverId, "/repo"), {
      isGit: true,
      cwd: "/repo",
      currentBranch: "feature",
    });
    return client;
  }

  it.each([1150, 390])(
    "watches with the composer agent at %s px and tracks the daemon inventory",
    async (width) => {
      await page.viewport(width, 760);
      seedHost([agent("focused"), agent("composer")], true, "focused");
      type Observe = Parameters<typeof createBackgroundWorkModel>[0]["observe"];
      let receive: Parameters<Observe>[0]["update"] = () => {};
      const model = createBackgroundWorkModel({
        list: async () => [],
        observe: ({ update }) => {
          receive = update;
          return () => {};
        },
      });
      const query = setupGitQueries();
      mountFixture();
      renderFixture(
        <QueryClientProvider client={query}>
          <MobilePanelsProvider>
            <View style={FILL_STYLE}>
              <ComposerTrackBar>
                <ComposerPrWatch
                  serverId={serverId}
                  workspaceId={workspaceId}
                  agentId="composer"
                  backgroundWork={model}
                />
              </ComposerTrackBar>
            </View>
          </MobilePanelsProvider>
        </QueryClientProvider>,
      );
      const pill = page.getByTestId("composer-pr-watch");
      await act(() => pill.click());
      await act(() => page.getByTestId("composer-pr-watch-start").click());
      expect(subscribe).toHaveBeenCalledExactlyOnceWith({ agentId: "composer", url: pr.url });
      await expect.element(page.getByTestId("pr-watch-agent-focused")).not.toBeInTheDocument();
      act(() =>
        receive([
          {
            id: "opaque",
            kind: "monitor",
            description: "acme/widgets #42",
            changeRequestUrl: pr.url,
            startedAt: "2026-11-25T00:00:00Z",
          },
        ]),
      );
      await expect.element(pill).toHaveTextContent("Watching #42");
      act(() => receive([]));
      await expect.element(pill).toHaveTextContent("PR #42");
      await act(async () => {
        query.setQueryData(checkoutPrStatusQueryKey(serverId, "/repo"), {
          githubFeaturesEnabled: true,
          status: { ...pr, state: "closed" },
          forge: "github",
        });
      });
      await expect.element(pill).not.toBeInTheDocument();
    },
  );

  it("opens the shared recipient dialog from Git actions", async () => {
    await page.viewport(1150, 780);
    seedHost([agent("selected")]);
    const query = setupGitQueries();
    mountFixture();
    renderFixture(
      <QueryClientProvider client={query}>
        <WorkspaceActions serverId={serverId} workspaceId={workspaceId} cwd="/repo" />
      </QueryClientProvider>,
    );
    await act(() => page.getByTestId("changes-primary-cta-caret").click());
    await act(() => page.getByRole("menuitem", { name: "Watch PR…" }).click());
    await expect
      .element(page.getByTestId("pr-watch-agent-selected"))
      .toHaveAttribute("aria-checked", "true");
    await act(() => page.getByTestId("pr-watch-confirm").click());
    expect(subscribe).toHaveBeenCalledExactlyOnceWith({ agentId: "selected", url: pr.url });
  });

  it("preselects the focused workspace agent and preserves selection after an error", async () => {
    await page.viewport(1150, 780);
    showPane(
      [agent("first"), agent("focused"), agent("archived", { archivedAt: new Date() })],
      true,
      "focused",
    );
    subscribe.mockRejectedValueOnce(new Error("Reconnect and try again."));
    await act(() => page.getByTestId("pr-pane-watch").click());
    await expect
      .element(page.getByTestId("pr-watch-agent-focused"))
      .toHaveAttribute("aria-checked", "true");
    await expect.element(page.getByTestId("pr-watch-agent-archived")).not.toBeInTheDocument();
    await act(() => page.getByTestId("pr-watch-confirm").click());
    await expect
      .element(page.getByRole("alert").filter({ hasText: "Reconnect and try again." }))
      .toBeVisible();
    await expect
      .element(page.getByTestId("pr-watch-agent-focused"))
      .toHaveAttribute("aria-checked", "true");
    await act(() => page.getByTestId("pr-watch-confirm").click());
    expect(subscribe.mock.calls).toEqual([
      [{ agentId: "focused", url: pr.url }],
      [{ agentId: "focused", url: pr.url }],
    ]);
  });

  it("preselects the sole workspace agent and reports a closed PR in a compact sheet", async () => {
    await page.viewport(390, 760);
    showPane([agent("only"), agent("other", { workspaceId: "another-workspace" })]);
    subscribe.mockResolvedValueOnce(false);
    await act(() => page.getByTestId("pr-pane-watch").click());
    await expect
      .element(page.getByTestId("pr-watch-agent-only"))
      .toHaveAttribute("aria-checked", "true");
    await act(() => page.getByTestId("pr-watch-confirm").click());
    await expect.element(page.getByText("This PR has already closed.")).toBeVisible();
  });

  it("requires a recipient on compact layouts when neither agent is focused", async () => {
    await page.viewport(390, 760);
    showPane([agent("first"), agent("second")]);
    await act(() => page.getByTestId("pr-pane-watch").click());
    await expect.element(page.getByTestId("pr-watch-confirm")).toBeDisabled();
    await act(() => page.getByTestId("pr-watch-agent-second").click());
    await act(() => page.getByTestId("pr-watch-confirm").click());
    expect(subscribe).toHaveBeenCalledExactlyOnceWith({ agentId: "second", url: pr.url });
  });

  it("offers host upgrade guidance without starting a watch on an older daemon", async () => {
    await page.viewport(1150, 780);
    showPane([agent("only")], false);
    await act(() => page.getByTestId("pr-pane-watch").click());
    await expect.element(page.getByText(/Update the host to start watches here/)).toBeVisible();
    await expect.element(page.getByTestId("pr-watch-confirm")).not.toBeInTheDocument();
    expect(subscribe).not.toHaveBeenCalled();
  });
});
