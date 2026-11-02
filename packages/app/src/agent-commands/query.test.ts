import { describe, expect, it } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { fetchQueryOptions } from "@/data/query";
import {
  agentCommandsQueryKey,
  agentCommandsQueryRoot,
  draftAgentCommandsQueryKey,
  normalizeAgentCommandsCwd,
  sessionAgentCommandsQueryKey,
  sessionCommandQueryPolicy,
} from "./cache";

it("reuses fresh commands and keeps stale commands during a shared refresh and failure", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: 300_000 } } });
  const key = sessionAgentCommandsQueryKey({ serverId: "s", agentId: "a" });
  let calls = 0;
  let fail = false;
  let resolveRefresh: (value: string[]) => void = () => {};
  const refresh = new Promise<string[]>((resolve) => {
    resolveRefresh = resolve;
  });
  const options = fetchQueryOptions({
    ...sessionCommandQueryPolicy,
    staleTimeMs: sessionCommandQueryPolicy.staleTime,
    dataShape: "value",
    queryKey: key,
    retry: false,
    queryFn: async () => {
      calls++;
      if (fail) throw new Error("offline");
      return refresh;
    },
  });
  client.setQueryData(key, ["old"]);
  const fresh = new QueryObserver(client, options);
  const unsubscribeFresh = fresh.subscribe(() => {});
  expect(calls).toBe(0);
  unsubscribeFresh();
  client.setQueryData(key, ["old"], { updatedAt: 1 });
  const first = new QueryObserver(client, options);
  const second = new QueryObserver(client, options);
  const unsubscribeFirst = first.subscribe(() => {});
  const unsubscribeSecond = second.subscribe(() => {});
  expect(calls).toBe(1);
  expect(first.getCurrentResult().data).toEqual(["old"]);
  expect(client.getQueryCache().find({ queryKey: key })?.gcTime).toBe(1_800_000);
  resolveRefresh(["new"]);
  await refresh;
  await first.refetch({ cancelRefetch: false });
  expect(second.getCurrentResult().data).toEqual(["new"]);
  fail = true;
  await client.invalidateQueries({ queryKey: key });
  expect(first.getCurrentResult().data).toEqual(["new"]);
  expect(first.getCurrentResult().isError).toBe(true);
  unsubscribeFirst();
  unsubscribeSecond();
  client.clear();
});

describe("agent command query keys", () => {
  it("shares draft commands across draft tabs with the same provider setup", () => {
    const draftConfig = {
      provider: "codex" as const,
      cwd: "/repo",
      modeId: "auto",
      model: "gpt-5.5",
      thinkingOptionId: "medium",
    };

    expect(
      agentCommandsQueryKey({ serverId: "server-1", agentId: "draft-a", draftConfig }),
    ).toEqual(agentCommandsQueryKey({ serverId: "server-1", agentId: "draft-b", draftConfig }));
  });

  it("keeps draft commands separate from running agent session commands", () => {
    expect(sessionAgentCommandsQueryKey({ serverId: "server-1", agentId: "agent-1" })).toEqual([
      "agentCommands",
      "server-1",
      "session",
      "agent-1",
    ]);
    expect(
      draftAgentCommandsQueryKey({
        serverId: "server-1",
        draftConfig: { provider: "codex", cwd: "/repo" },
      }),
    ).toEqual([
      "agentCommands",
      "server-1",
      "draft",
      "cwd",
      "/repo",
      "provider",
      "codex",
      "mode",
      null,
      "model",
      null,
      "thinking",
      null,
      "features",
      null,
    ]);
  });

  it("normalizes cwd values so equivalent workspace paths share one draft scope", () => {
    expect(normalizeAgentCommandsCwd("C:\\Users\\Ezekiel Bulver\\project")).toBe(
      "C:/Users/Ezekiel Bulver/project",
    );
    expect(
      draftAgentCommandsQueryKey({
        serverId: "server-1",
        draftConfig: { provider: "codex", cwd: "C:\\Users\\Ezekiel Bulver\\project" },
      }),
    ).toEqual(
      draftAgentCommandsQueryKey({
        serverId: "server-1",
        draftConfig: { provider: "codex", cwd: "C:/Users/Ezekiel Bulver/project" },
      }),
    );
  });

  it("exposes a server-level root for refresh invalidation", () => {
    expect(agentCommandsQueryRoot("server-1")).toEqual(["agentCommands", "server-1"]);
  });
});
