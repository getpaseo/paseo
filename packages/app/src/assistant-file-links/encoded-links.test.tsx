// @vitest-environment jsdom
import React, { type ReactNode } from "react";
import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { AssistantFileLinkResolverProvider } from "./provider";
import type { InlinePathTarget } from "./parse";
import type { AssistantFileLinkSource, GetDirectorySuggestions } from "./resolver";
import { useFileLink } from "./use-file-link";

afterEach(cleanup);

const RAW_SOURCE: AssistantFileLinkSource = {
  href: "literal%20.md",
  text: "literal%20.md",
  sourceType: "inline-code",
};
const HREF_SOURCE: AssistantFileLinkSource = { href: "literal%20.md" };

describe("encoded assistant links", () => {
  it.each([
    [RAW_SOURCE, HREF_SOURCE],
    [HREF_SOURCE, RAW_SOURCE],
  ])("opens raw and encoded filenames independently in order %j", async (first, second) => {
    const opened: InlinePathTarget[] = [];
    const searched: string[] = [];
    const queryClient = new QueryClient();
    const getDirectorySuggestions: GetDirectorySuggestions = async ({ query }) => {
      searched.push(query);
      return { entries: [{ path: query, kind: "file" }], error: null };
    };
    function Wrapper({ children }: { children: ReactNode }) {
      const client = React.useMemo(() => ({ getDirectorySuggestions }), []);
      const onOpenWorkspaceFile = React.useCallback((target: InlinePathTarget) => {
        opened.push(target);
      }, []);
      return (
        <QueryClientProvider client={queryClient}>
          <AssistantFileLinkResolverProvider
            serverId="server-1"
            workspaceRoot="/workspace"
            client={client}
            onOpenWorkspaceFile={onOpenWorkspaceFile}
          >
            {children}
          </AssistantFileLinkResolverProvider>
        </QueryClientProvider>
      );
    }
    const { result } = renderHook(() => useFileLink(first), { wrapper: Wrapper });
    for (const source of [first, second]) {
      act(() => result.current.open(source, "preferred"));
      const expectedPath = source.sourceType === "inline-code" ? "literal%20.md" : "literal .md";
      await waitFor(() => expect(opened.at(-1)?.path).toBe(`/workspace/${expectedPath}`));
    }
    expect(searched).toHaveLength(2);
    queryClient.clear();
  });
});
