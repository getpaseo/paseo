import { act, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { RetainedPanelActivity } from "@/components/retained-panel";
import { RetainedChatContent as NativeChat } from "./retained-chat-content.native";
import { RetainedChatContent as WebChat } from "./retained-chat-content.web";
import { useMountedTabSet } from "@/screens/workspace/use-mounted-tab-set";

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
