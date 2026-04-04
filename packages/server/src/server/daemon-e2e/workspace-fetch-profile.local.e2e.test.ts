import { describe, test, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import WebSocket from "ws";

import { DaemonClient } from "../../client/daemon-client.js";
import { createPaseoDaemon } from "../bootstrap.js";
import { loadConfig } from "../config.js";
import { resolvePaseoHome } from "../paseo-home.js";
import {
  getWorkspaceFetchProfileSnapshot,
  resetWorkspaceFetchProfile,
} from "../workspace-fetch-profiler.js";

const RUN = process.env.PASEO_WORKSPACE_FETCH_PROFILE_E2E === "1";
const runDescribe = RUN ? describe : describe.skip;

const PROFILE_HOME = process.env.PASEO_WORKSPACE_FETCH_PROFILE_HOME ?? resolvePaseoHome();
const PROFILE_RUNS = Math.max(
  1,
  Number.parseInt(process.env.PASEO_WORKSPACE_FETCH_PROFILE_RUNS ?? "3", 10),
);
const PROFILE_PAGE_LIMIT = Math.max(
  1,
  Number.parseInt(process.env.PASEO_WORKSPACE_FETCH_PROFILE_PAGE_LIMIT ?? "200", 10),
);

function createNodeWebSocketFactory() {
  return (
    url: string,
    config?: { headers?: Record<string, string> },
  ): WebSocket =>
    new WebSocket(url, {
      headers: config?.headers,
    });
}

async function connectProfileClient(port: number): Promise<DaemonClient> {
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${port}/ws`,
    clientId: "workspace-fetch-profile",
    clientType: "cli",
    webSocketFactory: createNodeWebSocketFactory(),
    reconnect: { enabled: false },
  } as unknown as ConstructorParameters<typeof DaemonClient>[0]);
  await client.connect();
  return client;
}

async function fetchWorkspacesLikeApp(client: DaemonClient): Promise<{
  workspaceCount: number;
  pageCount: number;
  totalMs: number;
}> {
  const startedAt = performance.now();
  let workspaceCount = 0;
  let pageCount = 0;
  let cursor: string | null = null;

  while (true) {
    const payload = await client.fetchWorkspaces({
      sort: [{ key: "activity_at", direction: "desc" }],
      page: cursor ? { limit: PROFILE_PAGE_LIMIT, cursor } : { limit: PROFILE_PAGE_LIMIT },
    });
    pageCount += 1;
    workspaceCount += payload.entries.length;

    if (!payload.pageInfo.hasMore || !payload.pageInfo.nextCursor) {
      break;
    }
    cursor = payload.pageInfo.nextCursor;
  }

  return {
    workspaceCount,
    pageCount,
    totalMs: performance.now() - startedAt,
  };
}

function printTopTable(
  label: string,
  entries: Array<{ label: string; count: number; totalMs: number; avgMs: number; maxMs: number }>,
  limit: number,
): void {
  console.info(
    `[workspace-fetch-profile] ${label}\n${JSON.stringify(entries.slice(0, limit), null, 2)}`,
  );
}

runDescribe("daemon E2E workspace fetch profiling", () => {
  test(
    "profiles app-like workspace sidebar fetches against the current PASEO_HOME",
    async () => {
      process.env.PASEO_PROFILE_WORKSPACE_FETCH = "1";

      const config = loadConfig(PROFILE_HOME);
      const daemon = await createPaseoDaemon(
        {
          ...config,
          listen: "127.0.0.1:0",
          paseoHome: PROFILE_HOME,
          agentStoragePath: path.join(PROFILE_HOME, "agents"),
          relayEnabled: false,
          mcpEnabled: false,
        },
        pino({ level: "warn" }),
      );

      const bootstrapStart = performance.now();
      await daemon.start();
      const bootstrapMs = performance.now() - bootstrapStart;

      const listenTarget = daemon.getListenTarget();
      expect(listenTarget?.type).toBe("tcp");
      const port = listenTarget && listenTarget.type === "tcp" ? listenTarget.port : null;
      if (!port) {
        throw new Error("Daemon did not expose a TCP listen target");
      }

      const client = await connectProfileClient(port);
      try {
        const readyStart = performance.now();
        await client.fetchAgents();
        const readinessMs = performance.now() - readyStart;

        const runSummaries: Array<{
          run: number;
          workspaceCount: number;
          pageCount: number;
          totalMs: number;
          profile: ReturnType<typeof getWorkspaceFetchProfileSnapshot>;
        }> = [];

        for (let run = 1; run <= PROFILE_RUNS; run += 1) {
          resetWorkspaceFetchProfile();
          const fetchSummary = await fetchWorkspacesLikeApp(client);
          const profile = getWorkspaceFetchProfileSnapshot();
          runSummaries.push({
            run,
            ...fetchSummary,
            profile,
          });

          console.info(
            "[workspace-fetch-profile] run-summary",
            JSON.stringify(
              {
                run,
                paseoHome: PROFILE_HOME,
                host: os.hostname(),
                bootstrapMs: Math.round(bootstrapMs),
                readinessMs: Math.round(readinessMs),
                workspaceCount: fetchSummary.workspaceCount,
                pageCount: fetchSummary.pageCount,
                totalMs: Math.round(fetchSummary.totalMs),
                aggregateCount: profile.totals.aggregateCount,
                commandCount: profile.totals.commandCount,
              },
              null,
              2,
            ),
          );
          printTopTable("top-aggregates", profile.aggregates, 20);
          printTopTable("top-commands", profile.commands, 20);
          console.info(
            `[workspace-fetch-profile] slowest-events\n${JSON.stringify(
              profile.slowest.slice(0, 25),
              null,
              2,
            )}`,
          );
        }

        expect(runSummaries[0]?.workspaceCount ?? 0).toBeGreaterThan(0);
      } finally {
        await client.close().catch(() => undefined);
        await daemon.stop().catch(() => undefined);
      }
    },
    30 * 60 * 1000,
  );
});
