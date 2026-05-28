/**
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import React, { useCallback, useMemo, useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ToastApi } from "@/components/toast-host";
import type { InlinePathTarget } from "./parse";
import { AssistantFileLinkResolverProvider } from "./provider";
import type { DirectorySuggestionResult } from "./resolver";
import { useFileLink } from "./use-file-link";
import type { OpenFileDisposition } from "@/workspace/file-open";

vi.mock("@/utils/open-external-url", () => ({
  openExternalUrl: vi.fn(async () => {}),
}));

const SOURCE = {
  href: "http://dumm.md",
  text: "dumm.md",
  markup: "linkify",
};

function resolvedSuggestions(
  entries: DirectorySuggestionResult["entries"],
): DirectorySuggestionResult {
  return { entries, error: null };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

interface OpenedFile {
  target: InlinePathTarget;
  disposition: OpenFileDisposition;
}

interface TestClient {
  getDirectorySuggestions: (input: {
    query: string;
    cwd: string;
    includeFiles: true;
    includeDirectories: false;
    matchMode: "suffix";
    limit: number;
  }) => Promise<DirectorySuggestionResult>;
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function createToast(): ToastApi {
  return {
    show: vi.fn<ToastApi["show"]>(),
    copied: vi.fn<ToastApi["copied"]>(),
    error: vi.fn<ToastApi["error"]>(),
  };
}

function createWrapper(input: { client: TestClient; openedFiles: OpenedFile[]; toast?: ToastApi }) {
  const queryClient = createQueryClient();
  return function Wrapper({ children }: { children: ReactNode }) {
    const openWorkspaceFile = useCallback(
      (target: InlinePathTarget, disposition: OpenFileDisposition) => {
        input.openedFiles.push({ target, disposition });
      },
      [],
    );

    return (
      <QueryClientProvider client={queryClient}>
        <AssistantFileLinkResolverProvider
          client={input.client}
          serverId="server-1"
          workspaceRoot="/Users/test/project"
          onOpenWorkspaceFile={openWorkspaceFile}
          toast={input.toast}
        >
          {children}
        </AssistantFileLinkResolverProvider>
      </QueryClientProvider>
    );
  };
}

describe("useFileLink", () => {
  it("returns the same object across no-op parent rerenders", () => {
    const getDirectorySuggestions = vi.fn(async () => resolvedSuggestions([]));
    const queryClient = createQueryClient();
    const Provider = AssistantFileLinkResolverProvider as React.ComponentType<
      Omit<React.ComponentProps<typeof AssistantFileLinkResolverProvider>, "children"> & {
        children?: ReactNode;
      }
    >;

    function ChurningProviderWrapper({ children }: { children: ReactNode }) {
      return React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(
          Provider,
          {
            client: { getDirectorySuggestions },
            serverId: "server-1",
            workspaceRoot: "/Users/test/project",
            onOpenWorkspaceFile: () => {},
            toast: createToast(),
          },
          children,
        ),
      );
    }

    const { result, rerender } = renderHook(() => useFileLink({ ...SOURCE }), {
      wrapper: ChurningProviderWrapper,
    });
    const first = result.current;

    rerender();

    expect(result.current).toBe(first);
    expect(result.current.onHoverIn).toBe(first.onHoverIn);
    expect(result.current.onPress).toBe(first.onPress);
    expect(result.current.onAuxPress).toBe(first.onAuxPress);
    expect(result.current.open).toBe(first.open);
  });

  it("does not cache unresolved lookups forever", async () => {
    const getDirectorySuggestions = vi
      .fn()
      .mockResolvedValueOnce(resolvedSuggestions([]))
      .mockResolvedValueOnce(resolvedSuggestions([{ path: "docs/dumm.md", kind: "file" }]));
    const openedFiles: OpenedFile[] = [];
    const toast = createToast();
    const { result } = renderHook(() => useFileLink(SOURCE), {
      wrapper: createWrapper({
        client: { getDirectorySuggestions },
        openedFiles,
        toast,
      }),
    });

    act(() => {
      result.current.onPress();
    });
    await waitFor(() => {
      expect(toast.show).toHaveBeenCalledWith("No file found for dumm.md", {
        variant: "error",
        testID: "assistant-file-link-not-found-toast",
      });
    });

    act(() => {
      result.current.onPress();
    });
    await waitFor(() => {
      expect(openedFiles).toEqual([
        {
          target: {
            raw: "dumm.md",
            path: "/Users/test/project/docs/dumm.md",
            lineStart: undefined,
            lineEnd: undefined,
          },
          disposition: "main",
        },
      ]);
    });
    expect(getDirectorySuggestions).toHaveBeenCalledTimes(2);
  });

  it("click retries after hover prefetch fails", async () => {
    const getDirectorySuggestions = vi
      .fn()
      .mockRejectedValueOnce(new Error("daemon unavailable"))
      .mockResolvedValueOnce(resolvedSuggestions([{ path: "docs/dumm.md", kind: "file" }]));
    const openedFiles: OpenedFile[] = [];
    const { result } = renderHook(() => useFileLink(SOURCE), {
      wrapper: createWrapper({
        client: { getDirectorySuggestions },
        openedFiles,
      }),
    });

    act(() => {
      result.current.onHoverIn();
    });
    await waitFor(() => {
      expect(getDirectorySuggestions).toHaveBeenCalledTimes(1);
    });

    act(() => {
      result.current.onPress();
    });
    await waitFor(() => {
      expect(openedFiles).toHaveLength(1);
    });
    expect(getDirectorySuggestions).toHaveBeenCalledTimes(2);
  });

  it("dedupes two links pointing at the same source", async () => {
    const deferred = createDeferred<DirectorySuggestionResult>();
    const getDirectorySuggestions = vi.fn(() => deferred.promise);
    const openedFiles: OpenedFile[] = [];
    const { result } = renderHook(
      () => ({
        first: useFileLink(SOURCE),
        second: useFileLink(SOURCE),
      }),
      {
        wrapper: createWrapper({
          client: { getDirectorySuggestions },
          openedFiles,
        }),
      },
    );

    act(() => {
      result.current.first.onHoverIn();
      result.current.second.onHoverIn();
    });
    await waitFor(() => {
      expect(getDirectorySuggestions).toHaveBeenCalledTimes(1);
    });
    deferred.resolve(resolvedSuggestions([{ path: "docs/dumm.md", kind: "file" }]));
    await waitFor(() => {
      expect(result.current.first.target?.path).toBe("/Users/test/project/docs/dumm.md");
      expect(result.current.second.target?.path).toBe("/Users/test/project/docs/dumm.md");
    });
  });

  it("hover then click uses the prefetched result", async () => {
    const getDirectorySuggestions = vi.fn(async () =>
      resolvedSuggestions([{ path: "docs/dumm.md", kind: "file" }]),
    );
    const openedFiles: OpenedFile[] = [];
    const { result } = renderHook(() => useFileLink(SOURCE), {
      wrapper: createWrapper({
        client: { getDirectorySuggestions },
        openedFiles,
      }),
    });

    act(() => {
      result.current.onHoverIn();
    });
    await waitFor(() => {
      expect(result.current.target?.path).toBe("/Users/test/project/docs/dumm.md");
    });

    act(() => {
      result.current.onPress();
    });
    await waitFor(() => {
      expect(openedFiles).toHaveLength(1);
    });
    expect(getDirectorySuggestions).toHaveBeenCalledTimes(1);
  });

  it("does not open a stale result after the workspace changes", async () => {
    const deferred = createDeferred<DirectorySuggestionResult>();
    const getDirectorySuggestions = vi.fn(() => deferred.promise);
    const openedFiles: OpenedFile[] = [];
    const queryClient = createQueryClient();

    function Wrapper({ children }: { children: ReactNode }) {
      const [workspaceRoot, setWorkspaceRoot] = useState("/Users/test/project");
      const client = useMemo(() => ({ getDirectorySuggestions }), []);
      const openWorkspaceFile = useCallback(
        (target: InlinePathTarget, disposition: OpenFileDisposition) => {
          openedFiles.push({ target, disposition });
        },
        [],
      );
      return (
        <QueryClientProvider client={queryClient}>
          <AssistantFileLinkResolverProvider
            client={client}
            serverId="server-1"
            workspaceRoot={workspaceRoot}
            onOpenWorkspaceFile={openWorkspaceFile}
          >
            <WorkspaceSwitchContext.Provider value={setWorkspaceRoot}>
              {children}
            </WorkspaceSwitchContext.Provider>
          </AssistantFileLinkResolverProvider>
        </QueryClientProvider>
      );
    }

    const { result } = renderHook(
      () => ({
        link: useFileLink(SOURCE),
        setWorkspaceRoot: React.useContext(WorkspaceSwitchContext),
      }),
      { wrapper: Wrapper },
    );

    act(() => {
      result.current.link.onPress();
    });
    act(() => {
      result.current.setWorkspaceRoot("/Users/test/other");
    });
    deferred.resolve(resolvedSuggestions([{ path: "docs/dumm.md", kind: "file" }]));

    await waitFor(() => {
      expect(getDirectorySuggestions).toHaveBeenCalledTimes(1);
    });
    expect(openedFiles).toEqual([]);
  });
});

const WorkspaceSwitchContext = React.createContext<(workspaceRoot: string) => void>(() => {});
