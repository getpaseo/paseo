import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
  agentCommandsQueryKey,
  agentCommandsQueryRoot,
  draftAgentCommandsQueryKey,
  invalidateDraftAgentCommandsForCwd,
  normalizeAgentCommandsCwd,
  sessionAgentCommandsQueryKey,
} from "./agent-commands-query";

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
      "codex",
      "cwd",
      "/repo",
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

describe("draft command invalidation", () => {
  function mountCommandMenu(input: {
    queryClient: QueryClient;
    cwd: string;
    discover: (attempt: number) => Promise<string[]>;
  }) {
    const queryKey = draftAgentCommandsQueryKey({
      serverId: "server-1",
      draftConfig: { provider: "claude", cwd: input.cwd },
    });
    let attempts = 0;
    const observer = new QueryObserver<string[]>(input.queryClient, {
      queryKey: [...queryKey],
      queryFn: () => {
        attempts += 1;
        return input.discover(attempts);
      },
      staleTime: Number.POSITIVE_INFINITY,
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => {});
    return { observer, queryKey, unsubscribe, attempts: () => attempts };
  }

  it("shows an open menu the in-flight result, then refreshes it", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let settleFirstDiscovery!: (commands: string[]) => void;
    const firstDiscovery = new Promise<string[]>((resolve) => {
      settleFirstDiscovery = resolve;
    });
    const menu = mountCommandMenu({
      queryClient,
      cwd: "/repo",
      discover: (attempt) => (attempt === 1 ? firstDiscovery : Promise.resolve(["/after"])),
    });
    await vi.waitFor(() => {
      expect(queryClient.getQueryState(menu.queryKey)?.fetchStatus).toBe("fetching");
    });

    await invalidateDraftAgentCommandsForCwd({
      queryClient,
      serverId: "server-1",
      cwd: "/repo",
      timing: "next-open",
    });
    settleFirstDiscovery(["/before"]);

    // The menu must never be left empty waiting for a discovery that was thrown away.
    await vi.waitFor(() => {
      expect(menu.observer.getCurrentResult().data).toEqual(["/after"]);
    });
    expect(menu.attempts()).toBe(2);
    menu.unsubscribe();
    queryClient.clear();
  });

  it("cancels discovery nothing is watching", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const menu = mountCommandMenu({
      queryClient,
      cwd: "/repo",
      discover: () => new Promise<string[]>(() => {}),
    });
    await vi.waitFor(() => {
      expect(queryClient.getQueryState(menu.queryKey)?.fetchStatus).toBe("fetching");
    });
    menu.unsubscribe();

    await invalidateDraftAgentCommandsForCwd({
      queryClient,
      serverId: "server-1",
      cwd: "/repo",
      timing: "next-open",
    });

    expect(queryClient.getQueryState(menu.queryKey)?.fetchStatus).toBe("idle");
    expect(queryClient.getQueryState(menu.queryKey)?.isInvalidated).toBe(true);
    queryClient.clear();
  });
});
