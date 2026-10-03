// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import React, { useMemo, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "zustand";
import { RetainedPanelActivity } from "@/components/retained-panel";
import { i18n } from "@/i18n/i18next";
import type { ExpandedPathsUpdate } from "@/stores/panel-store";
import type { ExplorerDirectory, ExplorerEntry } from "@/stores/session-store";
import { buildExplorerRevealKey, EXPLORER_REVEAL_REQUEST_TTL_MS } from "./reveal";
import { useExplorerRevealStore } from "./reveal-store";
import { flattenExplorerTree, type ExplorerListRow } from "./tree";
import {
  SCROLL_CONVERGENCE_BUDGET_MS,
  SCROLL_STALL_WINDOW_MS,
  useExplorerReveal,
  type ExplorerRevealScroller,
  type ScrollToIndexFailedInfo,
} from "./use-explorer-reveal";

const toast = vi.hoisted(() => ({ show: vi.fn(), copied: vi.fn(), error: vi.fn() }));
vi.mock("@/contexts/toast-context", () => ({ useToast: () => toast }));

const SERVER_ID = "server-1";
const WORKSPACE_STATE_KEY = "workspace:ws-main";
const REVEAL_KEY = buildExplorerRevealKey({
  serverId: SERVER_ID,
  workspaceStateKey: WORKSPACE_STATE_KEY,
});
/** A sibling worktree: its tree has the same relative paths as the main one. */
const SIBLING_WORKSPACE_STATE_KEY = "workspace:ws-sibling";

function entry(path: string, kind: ExplorerEntry["kind"]): ExplorerEntry {
  return {
    name: path.split("/").at(-1) ?? path,
    path,
    kind,
    size: 0,
    modifiedAt: "2026-01-01T00:00:00.000Z",
  };
}

const ROOT: ExplorerDirectory = {
  path: ".",
  entries: [entry("src", "directory"), entry(".env", "file"), entry("README.md", "file")],
};
const SRC: ExplorerDirectory = {
  path: "src",
  entries: [entry("src/index.ts", "file")],
};

const BIG_FILE_COUNT = 500;
const BIG_ROOT: ExplorerDirectory = { path: ".", entries: [entry("src", "directory")] };
/** A `src` listing of `count` files named `file-<index>.ts`, padded to `digits`. */
function numberedSrc(count: number, digits: number): ExplorerDirectory {
  return {
    path: "src",
    entries: Array.from({ length: count }, (_, index) =>
      entry(`src/file-${String(index).padStart(digits, "0")}.ts`, "file"),
    ),
  };
}
const BIG_SRC = numberedSrc(BIG_FILE_COUNT, 3);
const BIG_TARGET_PATH = `src/file-${String(BIG_FILE_COUNT - 1).padStart(3, "0")}.ts`;
const BIG_TARGET_INDEX = BIG_FILE_COUNT; // row 0 is "src" itself

type ListDirectory = (path: string) => Promise<ExplorerDirectory | null>;

async function listFromDisk(path: string): Promise<ExplorerDirectory | null> {
  if (path === ".") return ROOT;
  if (path === "src") return SRC;
  return null;
}

/** Stands in for the session and panel stores the pane reads its rows from. */
interface TreeState {
  directories: ReadonlyMap<string, ExplorerDirectory>;
  expandedPaths: string[];
  active: boolean;
  isTreeRestored: boolean;
  workspaceStateKey: string;
}

function createFixture(
  options: {
    active?: boolean;
    directories?: ReadonlyMap<string, ExplorerDirectory>;
    listDirectory?: ListDirectory;
    scroller?: ExplorerRevealScroller;
    isTreeRestored?: boolean;
  } = {},
) {
  const tree = create<TreeState>(() => ({
    directories: options.directories ?? new Map([[".", ROOT]]),
    expandedPaths: ["."],
    active: options.active ?? true,
    isTreeRestored: options.isTreeRestored ?? true,
    workspaceStateKey: WORKSPACE_STATE_KEY,
  }));
  const listDirectory = options.listDirectory ?? listFromDisk;
  const scroller: ExplorerRevealScroller = options.scroller ?? {
    scrollToIndex: vi.fn(),
    scrollToOffset: vi.fn(),
  };
  const treeListRef = { current: scroller };
  const requestDirectoryListing = vi.fn(async (path: string) => {
    const listed = await listDirectory(path);
    if (listed) {
      tree.setState((state) => ({ directories: new Map([...state.directories, [path, listed]]) }));
    }
    return listed;
  });
  const setExpandedPathsForWorkspace = vi.fn((_key: string, update: ExpandedPathsUpdate) => {
    tree.setState((state) => ({
      expandedPaths: typeof update === "function" ? update(state.expandedPaths) : update,
    }));
  });
  const selectExplorerEntry = vi.fn();

  function Wrapper({ children }: { children: ReactNode }) {
    const active = tree((state) => state.active);
    return <RetainedPanelActivity active={active}>{children}</RetainedPanelActivity>;
  }

  function useRevealInTree() {
    const directories = tree((state) => state.directories);
    const expandedPaths = tree((state) => state.expandedPaths);
    const isTreeRestored = tree((state) => state.isTreeRestored);
    const workspaceStateKey = tree((state) => state.workspaceStateKey);
    const listRows = useMemo(
      () =>
        flattenExplorerTree({
          directories,
          expandedPaths: new Set(expandedPaths),
          sortOption: "name",
          showHiddenFiles: false,
        }).map((row): ExplorerListRow => ({ type: "entry", row })),
      [directories, expandedPaths],
    );
    return useExplorerReveal({
      serverId: SERVER_ID,
      workspaceStateKey,
      directories,
      showHiddenFiles: false,
      listRows,
      treeListRef,
      requestDirectoryListing,
      setExpandedPathsForWorkspace,
      selectExplorerEntry,
      isTreeRestored,
    });
  }

  const hook = renderHook(useRevealInTree, { wrapper: Wrapper });
  return {
    hook,
    scroller,
    requestDirectoryListing,
    selectExplorerEntry,
    expandedPaths: () => tree.getState().expandedPaths,
    setActive: (active: boolean) => act(() => tree.setState({ active })),
    setTree: (state: Partial<TreeState>) => act(() => tree.setState(state)),
    simulateLayout: (height = 400) =>
      act(() => {
        hook.result.current.onListLayout({ nativeEvent: { layout: { height } } } as never);
      }),
    /** A scroll event, carrying the viewport length the list caches for its centering math. */
    simulateScroll: (viewportHeight: number) =>
      act(() => {
        hook.result.current.onListScroll({
          nativeEvent: { layoutMeasurement: { height: viewportHeight } },
        } as never);
      }),
    simulateContentSize: (height = 4_000) =>
      act(() => {
        hook.result.current.onListContentSizeChange(320, height);
      }),
  };
}

function requestReveal(path: string): void {
  act(() => {
    useExplorerRevealStore.getState().requestReveal({
      serverId: SERVER_ID,
      workspaceStateKey: WORKSPACE_STATE_KEY,
      path,
    });
  });
}

function deferredListing(): { listDirectory: ListDirectory; release: () => Promise<void> } {
  let resolvePending: (() => void) | null = null;
  return {
    listDirectory: (path) =>
      new Promise((resolve) => {
        resolvePending = () => resolve(path === "src" ? SRC : null);
      }),
    release: async () => {
      await act(async () => {
        resolvePending?.();
      });
    },
  };
}

/** Runs pending timers and frames up to `ms` from now, settling promises in between. */
async function advance(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** What the list reports when asked to center row 1 before it has measured past row 0. */
function reportUnmeasuredRow(
  onScrollToIndexFailed: (info: ScrollToIndexFailedInfo) => void,
  info: ScrollToIndexFailedInfo = { index: 1, averageItemLength: 24, highestMeasuredFrameIndex: 0 },
): void {
  act(() => onScrollToIndexFailed(info));
}

const FRAME_MS = 16;

const CENTERED = { viewPosition: 0.5, viewOffset: 0, animated: true };

function scrollToIndexCalls(scroller: ExplorerRevealScroller): number {
  return (scroller.scrollToIndex as ReturnType<typeof vi.fn>).mock.calls.length;
}

/**
 * Simulates a `FlatList` that renders one `batchSize` batch of rows every `batchIntervalMs`
 * (RN's `maxToRenderPerBatch` waves arrive 60-100 ms apart, several frames each). A
 * `scrollToIndex` past the rendered frontier reports failure through the same callback the real
 * list uses.
 */
function createBatchingScroller(input: {
  totalRows: number;
  batchSize: number;
  batchIntervalMs: number;
  initialFrontier: number;
}): {
  scroller: ExplorerRevealScroller;
  connect: (callback: (info: ScrollToIndexFailedInfo) => void) => void;
} {
  let frontier = input.initialFrontier;
  let onFailed: ((info: ScrollToIndexFailedInfo) => void) | null = null;
  const scroller: ExplorerRevealScroller = {
    scrollToIndex: vi.fn(({ index }: { index: number }) => {
      if (index > frontier) {
        onFailed?.({ index, averageItemLength: 24, highestMeasuredFrameIndex: frontier });
      }
    }),
    scrollToOffset: vi.fn(),
  };
  return {
    scroller,
    connect: (callback) => {
      onFailed = callback;
      setInterval(() => {
        frontier = Math.min(frontier + input.batchSize, input.totalRows - 1);
      }, input.batchIntervalMs);
    },
  };
}

function createBigFixture(scroller: ExplorerRevealScroller) {
  return createFixture({
    directories: new Map([
      [".", BIG_ROOT],
      ["src", BIG_SRC],
    ]),
    scroller,
  });
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "Date",
    ],
  });
  useExplorerRevealStore.setState({ requests: {} });
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useExplorerReveal", () => {
  it("expands, selects, and centers the file, then clears the request", async () => {
    const fixture = createFixture();

    requestReveal("src/index.ts");
    await advance();

    expect(fixture.scroller.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(fixture.scroller.scrollToIndex).toHaveBeenCalledWith({ index: 1, ...CENTERED });
    expect(fixture.requestDirectoryListing).toHaveBeenCalledWith("src", {
      recordHistory: false,
      setCurrentPath: false,
    });
    expect(fixture.expandedPaths()).toEqual([".", "src"]);
    expect(fixture.selectExplorerEntry).toHaveBeenCalledWith("src/index.ts");
    expect(useExplorerRevealStore.getState().requests).toEqual({});
  });

  it("waits for the root listing before revealing a request made before mount", async () => {
    requestReveal("README.md");
    const fixture = createFixture({ directories: new Map() });
    await advance();
    expect(fixture.selectExplorerEntry).not.toHaveBeenCalled();

    fixture.setTree({ directories: new Map([[".", ROOT]]) });
    await advance();

    expect(fixture.scroller.scrollToIndex).toHaveBeenCalledWith({ index: 1, ...CENTERED });
    expect(fixture.selectExplorerEntry).toHaveBeenCalledWith("README.md");
  });

  it("waits for the tree to restore its persisted folders before expanding anything", async () => {
    const fixture = createFixture({ isTreeRestored: false });

    requestReveal("src/index.ts");
    await advance();
    expect(fixture.requestDirectoryListing).not.toHaveBeenCalled();
    expect(fixture.expandedPaths()).toEqual(["."]);
    expect(fixture.selectExplorerEntry).not.toHaveBeenCalled();

    // The restore rewrote the expanded set when it landed; the reveal expands on top of it.
    fixture.setTree({ expandedPaths: [".", "restored"], isTreeRestored: true });
    await advance();

    expect(fixture.expandedPaths()).toEqual([".", "restored", "src"]);
    expect(fixture.selectExplorerEntry).toHaveBeenCalledWith("src/index.ts");
  });

  it("leaves the request pending while the tree has never been visible", async () => {
    const fixture = createFixture({ active: false });

    requestReveal("README.md");
    await advance();

    expect(fixture.selectExplorerEntry).not.toHaveBeenCalled();
    expect(useExplorerRevealStore.getState().requests[REVEAL_KEY]).toEqual({
      path: "README.md",
      requestId: expect.any(Number),
      createdAt: expect.any(Number),
    });
  });

  it("abandons a reveal when the tree is hidden during its listing", async () => {
    const listing = deferredListing();
    const fixture = createFixture({ listDirectory: listing.listDirectory });

    requestReveal("src/index.ts");
    await advance();
    expect(fixture.requestDirectoryListing).toHaveBeenCalledTimes(1);
    fixture.setActive(false);
    expect(useExplorerRevealStore.getState().requests).toEqual({});
    await listing.release();
    await advance(SCROLL_STALL_WINDOW_MS);

    expect(fixture.selectExplorerEntry).not.toHaveBeenCalled();
    expect(fixture.scroller.scrollToIndex).not.toHaveBeenCalled();
    expect(toast.show).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it.each([
    { path: "src/index.ts", outcome: "found" },
    { path: "src/deleted.ts", outcome: "missing" },
  ])(
    "abandons a reveal ($outcome file) when the tree switches workspace during its listing",
    async ({ path }) => {
      const listing = deferredListing();
      const fixture = createFixture({ listDirectory: listing.listDirectory });

      requestReveal(path);
      await advance();
      expect(fixture.requestDirectoryListing).toHaveBeenCalledTimes(1);
      fixture.setTree({ workspaceStateKey: SIBLING_WORKSPACE_STATE_KEY });
      expect(useExplorerRevealStore.getState().requests).toEqual({});
      await listing.release();
      await advance(SCROLL_STALL_WINDOW_MS);

      // The sibling tree has the same relative path; it must not be selected, scrolled, or toasted.
      expect(fixture.requestDirectoryListing).toHaveBeenCalledTimes(1);
      expect(fixture.selectExplorerEntry).not.toHaveBeenCalled();
      expect(fixture.scroller.scrollToIndex).not.toHaveBeenCalled();
      expect(toast.show).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
    },
  );

  it("drops a waiting request when the tree is hidden, so it never replays", async () => {
    requestReveal("README.md");
    const fixture = createFixture({ directories: new Map() });
    await advance();

    fixture.setActive(false);
    expect(useExplorerRevealStore.getState().requests).toEqual({});
    fixture.setTree({ active: true, directories: new Map([[".", ROOT]]) });
    await advance();

    expect(fixture.selectExplorerEntry).not.toHaveBeenCalled();
    expect(fixture.scroller.scrollToIndex).not.toHaveBeenCalled();
  });

  it("drops a request that outlived its time limit without starting", async () => {
    useExplorerRevealStore.setState({
      requests: {
        [REVEAL_KEY]: {
          path: "README.md",
          requestId: 99,
          createdAt: Date.now() - EXPLORER_REVEAL_REQUEST_TTL_MS - 1,
        },
      },
    });

    const fixture = createFixture();
    await advance();

    expect(useExplorerRevealStore.getState().requests).toEqual({});
    expect(fixture.selectExplorerEntry).not.toHaveBeenCalled();
    expect(fixture.scroller.scrollToIndex).not.toHaveBeenCalled();
  });

  it("re-centers when the same path is revealed again", async () => {
    const fixture = createFixture();

    requestReveal("README.md");
    await advance();
    expect(fixture.scroller.scrollToIndex).toHaveBeenCalledTimes(1);
    requestReveal("README.md");
    await advance();

    expect(fixture.scroller.scrollToIndex).toHaveBeenCalledTimes(2);
    expect(fixture.selectExplorerEntry).toHaveBeenCalledTimes(2);
  });

  it("explains a hidden file without toggling the hidden-files setting", async () => {
    const fixture = createFixture();

    requestReveal(".env");
    await advance();

    expect(toast.show).toHaveBeenCalledWith(i18n.t("workspace.fileExplorer.reveal.hidden"));
    expect(fixture.selectExplorerEntry).not.toHaveBeenCalled();
    expect(fixture.scroller.scrollToIndex).not.toHaveBeenCalled();
  });

  it("reports a file missing from its directory listing", async () => {
    const fixture = createFixture();

    requestReveal("src/deleted.ts");
    await advance();

    expect(toast.error).toHaveBeenCalledWith(i18n.t("workspace.fileExplorer.reveal.notFound"));
    expect(fixture.selectExplorerEntry).not.toHaveBeenCalled();
    expect(useExplorerRevealStore.getState().requests).toEqual({});
  });

  describe("scroll convergence", () => {
    it("jumps near an unmeasured row, then retries centering on the next frame", async () => {
      const fixture = createFixture();
      requestReveal("src/index.ts");
      await advance();

      reportUnmeasuredRow(fixture.hook.result.current.onScrollToIndexFailed);
      expect(fixture.scroller.scrollToOffset).toHaveBeenCalledWith({ offset: 24, animated: false });
      await advance(FRAME_MS);

      expect(fixture.scroller.scrollToIndex).toHaveBeenCalledTimes(2);
      expect(fixture.scroller.scrollToIndex).toHaveBeenLastCalledWith({ index: 1, ...CENTERED });
    });

    it("re-centers once the list reports a real viewport, ignoring a hidden one", async () => {
      const fixture = createFixture();
      requestReveal("src/index.ts");
      await advance();
      expect(fixture.scroller.scrollToIndex).toHaveBeenCalledTimes(1);

      fixture.simulateLayout(0); // still display: none
      await advance(FRAME_MS);
      expect(fixture.scroller.scrollToIndex).toHaveBeenCalledTimes(1);

      fixture.simulateLayout(728);
      await advance(FRAME_MS);
      expect(fixture.scroller.scrollToIndex).toHaveBeenCalledTimes(2);
      expect(fixture.scroller.scrollToIndex).toHaveBeenLastCalledWith({ index: 1, ...CENTERED });
    });

    it("centers a retained tree against its real viewport, not the one it cached while hidden", async () => {
      const fixture = createFixture();
      fixture.simulateLayout(678);
      // Hiding the retained tree reports a collapsed viewport through a scroll event, and showing
      // it again at the same size fires no layout, so the list still holds the collapsed length.
      fixture.setActive(false);
      fixture.simulateScroll(0);
      fixture.setActive(true);

      requestReveal("src/index.ts");
      await advance();

      // One animated scroll straight to center: the offset makes up the list's missing 339 px.
      expect(fixture.scroller.scrollToIndex).toHaveBeenCalledTimes(1);
      expect(fixture.scroller.scrollToIndex).toHaveBeenCalledWith({
        index: 1,
        viewPosition: 0.5,
        viewOffset: 339,
        animated: true,
      });

      // That scroll's own events refresh the list's length; the closing pass needs no offset.
      fixture.simulateScroll(678);
      await advance(SCROLL_STALL_WINDOW_MS);
      expect(fixture.scroller.scrollToIndex).toHaveBeenCalledTimes(2);
      expect(fixture.scroller.scrollToIndex).toHaveBeenLastCalledWith({ index: 1, ...CENTERED });
    });

    it("jumps an unmeasured row to its estimated centered offset, not to the viewport top", async () => {
      const fixture = createFixture();
      fixture.simulateLayout(678);
      requestReveal("src/index.ts");
      await advance();

      reportUnmeasuredRow(fixture.hook.result.current.onScrollToIndexFailed, {
        index: 94,
        averageItemLength: 30,
        highestMeasuredFrameIndex: 70,
      });

      // 94 rows of 30 px, less half of the viewport that is not the row itself.
      expect(fixture.scroller.scrollToOffset).toHaveBeenCalledWith({
        offset: 94 * 30 - (678 - 30) / 2,
        animated: false,
      });
    });

    it("re-centers as rendered batches grow the content, once per frame", async () => {
      const fixture = createFixture();
      requestReveal("src/index.ts");
      await advance();

      fixture.simulateContentSize(3_000);
      fixture.simulateContentSize(3_600);
      await advance(FRAME_MS);

      expect(fixture.scroller.scrollToIndex).toHaveBeenCalledTimes(2);
    });

    it("centers once more after the list goes quiet, then never scrolls again", async () => {
      const fixture = createFixture();
      requestReveal("src/index.ts");
      await advance();
      fixture.simulateContentSize();
      await advance(FRAME_MS);
      expect(fixture.scroller.scrollToIndex).toHaveBeenCalledTimes(2);

      await advance(SCROLL_STALL_WINDOW_MS);
      expect(fixture.scroller.scrollToIndex).toHaveBeenCalledTimes(3);

      fixture.simulateLayout(900); // a window resize later is not part of the reveal
      fixture.simulateContentSize(5_000);
      reportUnmeasuredRow(fixture.hook.result.current.onScrollToIndexFailed);
      await advance(SCROLL_CONVERGENCE_BUDGET_MS);

      expect(fixture.scroller.scrollToIndex).toHaveBeenCalledTimes(3);
      expect(fixture.scroller.scrollToOffset).not.toHaveBeenCalled();
    });

    it("ends the attempt when the revealed row is collapsed away", async () => {
      const fixture = createFixture();
      requestReveal("src/index.ts");
      await advance();

      fixture.setTree({ expandedPaths: ["."] });
      fixture.simulateContentSize();
      await advance(SCROLL_STALL_WINDOW_MS);

      expect(fixture.scroller.scrollToIndex).toHaveBeenCalledTimes(1);
    });

    it("stops steering the scroll when the tree is hidden mid-attempt", async () => {
      const fixture = createFixture();
      requestReveal("src/index.ts");
      await advance();

      fixture.setActive(false);
      fixture.simulateContentSize();
      await advance(SCROLL_STALL_WINDOW_MS);

      expect(fixture.scroller.scrollToIndex).toHaveBeenCalledTimes(1);
    });

    it("clears its pending frame and stall timer on unmount, then never scrolls", async () => {
      const fixture = createFixture();
      requestReveal("src/index.ts");
      await advance();
      fixture.simulateContentSize(); // queues a frame and restarts the stall window

      fixture.hook.unmount();
      expect(vi.getTimerCount()).toBe(0);
      await advance(SCROLL_CONVERGENCE_BUDGET_MS);

      expect(fixture.scroller.scrollToIndex).toHaveBeenCalledTimes(1);
      expect(fixture.scroller.scrollToOffset).not.toHaveBeenCalled();
    });

    it("keeps retrying while batches arrive several frames apart, converging on a large tree", async () => {
      const batching = createBatchingScroller({
        totalRows: BIG_FILE_COUNT + 1,
        batchSize: 40,
        batchIntervalMs: 90,
        initialFrontier: 23,
      });
      const fixture = createBigFixture(batching.scroller);
      batching.connect(fixture.hook.result.current.onScrollToIndexFailed);

      requestReveal(BIG_TARGET_PATH);
      await advance();
      expect(fixture.selectExplorerEntry).toHaveBeenCalledWith(BIG_TARGET_PATH);

      // ~12 batches of 40 rows at 90 ms each: past what a frame-counted stall check allows.
      await advance(2_000);

      expect(batching.scroller.scrollToIndex).toHaveBeenLastCalledWith({
        index: BIG_TARGET_INDEX,
        ...CENTERED,
      });
      const failedAtTarget = (batching.scroller.scrollToOffset as ReturnType<typeof vi.fn>).mock
        .calls.length;
      expect(failedAtTarget).toBeGreaterThan(12);
    });

    it("gives up after the stall window when rendering makes no progress", async () => {
      const batching = createBatchingScroller({
        totalRows: BIG_FILE_COUNT + 1,
        batchSize: 0,
        batchIntervalMs: 90,
        initialFrontier: 23,
      });
      const fixture = createBigFixture(batching.scroller);
      batching.connect(fixture.hook.result.current.onScrollToIndexFailed);

      requestReveal(BIG_TARGET_PATH);
      await advance();
      await advance(SCROLL_STALL_WINDOW_MS + FRAME_MS);
      const callCount = scrollToIndexCalls(batching.scroller);

      await advance(SCROLL_CONVERGENCE_BUDGET_MS);

      expect(scrollToIndexCalls(batching.scroller)).toBe(callCount);
    });

    it("gives up once the time budget elapses even while rendering keeps advancing", async () => {
      const batching = createBatchingScroller({
        totalRows: 100_000,
        batchSize: 1, // always a little further, so only the budget can end it
        batchIntervalMs: 90,
        initialFrontier: 23,
      });
      const hugeSrc = numberedSrc(5_000, 4);
      const fixture = createFixture({
        directories: new Map([
          [".", BIG_ROOT],
          ["src", hugeSrc],
        ]),
        scroller: batching.scroller,
      });
      batching.connect(fixture.hook.result.current.onScrollToIndexFailed);

      requestReveal("src/file-4999.ts");
      await advance();
      await advance(SCROLL_CONVERGENCE_BUDGET_MS + FRAME_MS);
      const callCount = scrollToIndexCalls(batching.scroller);

      await advance(SCROLL_CONVERGENCE_BUDGET_MS);

      expect(scrollToIndexCalls(batching.scroller)).toBe(callCount);
    });
  });
});
