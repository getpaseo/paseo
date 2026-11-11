import React, {
  act,
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RetainedPanelActivity, useRetainedPanelActive } from "@/components/retained-panel";
import { RetainedChatContent as NativeChat } from "./retained-chat-content.native";
import { RetainedChatContent as WebChat } from "./retained-chat-content.web";
import { useMountedTabSet } from "@/screens/workspace/use-mounted-tab-set";

import {
  ComposerEditingScope,
  ComposerEditingSessionsProvider,
  WorkspaceComposerEditingSessionsProvider,
  useComposerEditingSession,
} from "@/composer/editing-session";
import {
  DiffDocumentWorkspaceCacheProvider,
  useDiffDocumentWorkspaceCache,
} from "@/git/diff-document/workspace-cache";
import {
  AssistantFileLinkResolverProvider,
  useAssistantFileLinkEnvironment,
} from "@/assistant-file-links";
import type { ContextBridge } from "@/components/ui/isolated-bottom-sheet-modal";

import { render as renderEnvironment } from "@testing-library/react";
import { useWorkspaceSheetEnvironment } from "@/screens/workspace/workspace-sheet-environment";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAssistantFileLinkActions, type InlinePathTarget } from "@/assistant-file-links";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

for (const [runtime, Chat] of [
  ["native", NativeChat],
  ["web", WebChat],
] as const) {
  it(`${runtime} retains local state while applying its hidden rendering policy`, async () => {
    let version = 0,
      commits = 0,
      mounts = 0;
    const listeners = new Set<() => void>();
    const subscribe = (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    };
    function Content() {
      const value = useSyncExternalStore(subscribe, () => version);
      const [local] = useState(() => "unsaved-local-draft");
      useLayoutEffect(() => {
        mounts++;
      }, []);
      useLayoutEffect(() => {
        commits++;
      });
      return (
        <span>
          {local}:{value}
        </span>
      );
    }
    const render = (active: boolean) =>
      act(() =>
        root.render(
          <RetainedPanelActivity active={active}>
            <Chat>
              <Content />
            </Chat>
          </RetainedPanelActivity>,
        ),
      );
    render(true);
    render(false);
    const hiddenCommits = commits;
    await act(async () => {
      version++;
      listeners.forEach((listener) => listener());
    });
    expect(commits - hiddenCommits).toBe(runtime === "native" ? 1 : 0);
    render(true);
    expect(container.textContent).toBe("unsaved-local-draft:1");
    // Web Suspense reruns layout effects on reveal; local state survives in both runtimes.
    expect(mounts).toBe(runtime === "native" ? 1 : 2);
  });
}

it("retains modified panels beyond the LRU cap and evicts them normally after save", () => {
  let mounted: string[] = [];
  const allTabIds = ["a", "b", "c", "d", "e"];
  function Host({ active, modified }: { active: string; modified: Set<string> }) {
    const { mountedTabIds } = useMountedTabSet({
      activeTabId: active,
      allTabIds,
      retainedTabIds: modified,
      cap: 3,
    });
    mounted = [...mountedTabIds];
    return null;
  }
  const render = (active: string, modified = new Set<string>()) =>
    act(() => root.render(<Host active={active} modified={modified} />));
  render("a");
  render("b");
  render("c");
  render("d");
  expect(mounted).toEqual(["d", "c", "b"]);
  render("e", new Set(["a", "b", "c", "d"]));
  expect(mounted).toEqual(["e", "a", "b", "c", "d"]);
  render("e");
  expect(mounted).toEqual(["e", "a", "b"]);
});

describe("workspace sheet environment", () => {
  it("shares editing sessions and diff cache across the host, keeping resolver updates live", async () => {
    let bridge: ContextBridge = (children) => children;
    const observations = new Map<string, ReturnType<typeof useEnvironment>>();
    let mounts = 0;
    const queryClient = new QueryClient();
    const opened: Array<{ root: string; path: string }> = [];
    function useEnvironment() {
      return {
        session: useComposerEditingSession("chat"),
        cache: useDiffDocumentWorkspaceCache(),
        files: useAssistantFileLinkEnvironment(),
        active: useRetainedPanelActive(),
        actions: useAssistantFileLinkActions(),
      };
    }
    function Probe({ name }: { name: string }) {
      observations.set(name, useEnvironment());
      useEffect(() => {
        if (name === "sheet") mounts++;
      }, [name]);
      return null;
    }
    function Capture() {
      bridge = useWorkspaceSheetEnvironment();
      return (
        <ComposerEditingScope tabId="file" targetKey="file:a">
          <Probe name="pane" />
        </ComposerEditingScope>
      );
    }
    function Source({ workspaceRoot, active }: { workspaceRoot: string; active: boolean }) {
      const onOpenFile = useCallback(
        (target: InlinePathTarget) => {
          opened.push({ root: workspaceRoot, path: target.path });
        },
        [workspaceRoot],
      );
      return (
        <QueryClientProvider client={queryClient}>
          <ComposerEditingSessionsProvider>
            <WorkspaceComposerEditingSessionsProvider
              workspaceKey="host:workspace"
              tabIds={["file"]}
            >
              <DiffDocumentWorkspaceCacheProvider>
                <AssistantFileLinkResolverProvider
                  workspaceRoot={workspaceRoot}
                  onOpenWorkspaceFile={onOpenFile}
                >
                  <RetainedPanelActivity active={active}>
                    <Capture />
                  </RetainedPanelActivity>
                </AssistantFileLinkResolverProvider>
              </DiffDocumentWorkspaceCacheProvider>
            </WorkspaceComposerEditingSessionsProvider>
          </ComposerEditingSessionsProvider>
        </QueryClientProvider>
      );
    }
    const source = renderEnvironment(<Source workspaceRoot="/before" active />);
    const sheetContent = (
      <ComposerEditingScope tabId="file" targetKey="file:a">
        <Probe name="sheet" />
      </ComposerEditingScope>
    );
    const sheet = renderEnvironment(
      <QueryClientProvider client={queryClient}>{bridge(sheetContent)}</QueryClientProvider>,
    );
    const pane = observations.get("pane")!;
    expect(observations.get("sheet")?.session).toBe(pane.session);
    expect(observations.get("sheet")?.cache).toBe(pane.cache);
    expect(observations.get("sheet")?.files.workspaceRoot).toBe("/before");
    const actions = observations.get("sheet")!.actions;
    act(() => pane.session.setFullscreen(true));
    source.rerender(<Source workspaceRoot="/after" active={false} />);
    // An action captured before the provider update must already use the live resolver value.
    await act(async () => actions.open({ href: "/after/linked.ts" }, "preferred"));
    expect(opened).toEqual([{ root: "/after", path: "/after/linked.ts" }]);
    sheet.rerender(
      <QueryClientProvider client={queryClient}>{bridge(sheetContent)}</QueryClientProvider>,
    );
    expect(observations.get("sheet")?.session).toBe(pane.session);
    expect(observations.get("sheet")?.session.getFullscreen()).toBe(true);
    expect(observations.get("sheet")?.cache).toBe(pane.cache);
    expect(observations.get("sheet")?.files.workspaceRoot).toBe("/after");
    expect(observations.get("sheet")?.active).toBe(false);
    expect(mounts).toBe(1);
    sheet.unmount();
    source.unmount();
  });
});
