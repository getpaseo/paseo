// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it } from "vitest";
import { createWorkspaceBrowser, useBrowserStore, waitForBrowserHydration } from "./store";
import { profilePartition, workspaceProfile } from "./profiles";
import { useBrowserTabProfile } from "./use-browser-tab-profile";

const created: string[] = [];
afterEach(() => {
  for (const browserId of created.splice(0)) useBrowserStore.getState().removeBrowser(browserId);
});

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
let queryClient = new QueryClient();

function blankTab(): string {
  const { browserId } = createWorkspaceBrowser({ initialUrl: undefined });
  created.push(browserId);
  return browserId;
}

it("a workspace rename relabels a live tab without changing its partition", async () => {
  queryClient = new QueryClient();
  await waitForBrowserHydration();
  const browserId = blankTab();
  const ids = { browserId, serverId: "server", projectId: "project", workspaceId: "workspace" };
  const partitions: Array<string | undefined> = [];
  const { result, rerender } = renderHook(
    ({ workspaceName }: { workspaceName: string }) => {
      const profile = useBrowserTabProfile({ ...ids, workspaceName });
      partitions.push(profile.partition);
      return profile;
    },
    { initialProps: { workspaceName: "Main" }, wrapper },
  );
  const automatic = await workspaceProfile("server", "project", "workspace", "Main");
  const expected = await profilePartition(automatic);
  await waitFor(() => expect(result.current.partition).toBe(expected));
  expect(useBrowserStore.getState().browsersById[browserId]?.profile).toEqual(automatic);

  const attachedAt = partitions.indexOf(expected);
  rerender({ workspaceName: "Renamed" });
  await waitFor(() => expect(result.current.automatic?.name).toBe("Renamed"));
  rerender({ workspaceName: "Renamed again" });
  await waitFor(() => expect(result.current.automatic?.name).toBe("Renamed again"));

  // The pane attaches, and re-parks, its webview whenever this value changes.
  expect(new Set(partitions.slice(attachedAt))).toEqual(new Set([expected]));
  expect(result.current.selected?.slug).toBe(automatic.slug);
  expect(result.current.unavailable).toBe(false);
});

it("reports a missing or unreadable browser record as unavailable", async () => {
  queryClient = new QueryClient();
  await waitForBrowserHydration();
  const input = { serverId: "server", projectId: "project", workspaceId: "w", workspaceName: "W" };
  const missing = renderHook(() => useBrowserTabProfile({ ...input, browserId: "absent" }), {
    wrapper,
  });
  expect(missing.result.current).toMatchObject({ unavailable: true, partition: undefined });

  const browserId = blankTab();
  useBrowserStore.setState((state) => ({
    browsersById: {
      ...state.browsersById,
      [browserId]: { ...state.browsersById[browserId], profile: "invalid" },
    },
  }));
  const invalid = renderHook(() => useBrowserTabProfile({ ...input, browserId }), { wrapper });
  expect(invalid.result.current).toMatchObject({ unavailable: true, partition: undefined });
});
