/** @vitest-environment jsdom */
import React from "react";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { Assistant } from "@getpaseo/protocol/assistants";
import { useAssistants } from "./assistant-queries";

const connection = vi.hoisted(() => ({
  sessions: { host: { client: null as DaemonClient | null } },
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (value: typeof connection) => unknown) => selector(connection),
}));
vi.mock("./assistant-selection-store", () => ({ useAssistantSelectionStore: () => () => {} }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

it("does not display a prior connection's private assistants while a replacement connection loads", async () => {
  const firstList = [{ id: `ast_${"a".repeat(32)}`, name: "Private assistant" }] as Assistant[];
  connection.sessions.host.client = {
    listAssistants: async () => firstList,
  } as unknown as DaemonClient;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  const hook = renderHook(() => useAssistants("host"), { wrapper: Wrapper });
  await waitFor(() => expect(hook.result.current.assistants).toEqual(firstList));
  let resolve!: (assistants: Assistant[]) => void;
  const loading = new Promise<Assistant[]>((done) => {
    resolve = done;
  });
  connection.sessions.host.client = { listAssistants: () => loading } as unknown as DaemonClient;
  hook.rerender();
  expect(hook.result.current.assistants).toEqual([]);
  resolve([]);
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  client.clear();
});
