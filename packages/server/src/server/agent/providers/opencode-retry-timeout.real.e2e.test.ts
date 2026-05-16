import http from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test } from "vitest";

import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";
import { OpenCodeServerManager } from "./opencode/server-manager.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("server did not bind to a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

test("does not fail an active OpenCode provider retry before the advertised retry delay elapses", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-opencode-retry-"));
  const projectDir = path.join(root, "project");
  const xdgConfigHome = path.join(root, "config");
  const xdgDataHome = path.join(root, "data");
  const xdgCacheHome = path.join(root, "cache");
  await mkdir(projectDir, { recursive: true });
  await mkdir(xdgConfigHome, { recursive: true });
  await mkdir(xdgDataHome, { recursive: true });
  await mkdir(xdgCacheHome, { recursive: true });

  let completionRequests = 0;
  let turnStartedAt = 0;
  const requestLog: Array<{ elapsedMs: number; request: number }> = [];
  const providerServer = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "flaky-model", object: "model" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      completionRequests += 1;
      requestLog.push({
        elapsedMs: turnStartedAt === 0 ? -1 : Date.now() - turnStartedAt,
        request: completionRequests,
      });
      req.resume();
      res.writeHead(503, {
        "content-type": "application/json",
        "retry-after-ms": "15000",
      });
      res.end(
        JSON.stringify({
          error: {
            message: `engine overloaded request ${completionRequests}`,
            type: "server_error",
            code: "server_error",
          },
        }),
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  const port = await listen(providerServer);
  await writeFile(
    path.join(projectDir, "opencode.json"),
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        model: "flaky/flaky-model",
        enabled_providers: ["flaky"],
        provider: {
          flaky: {
            npm: "@ai-sdk/openai-compatible",
            name: "Flaky local provider",
            options: {
              baseURL: `http://127.0.0.1:${port}/v1`,
              apiKey: "test-key",
              timeout: false,
            },
            models: {
              "flaky-model": {
                name: "Flaky Model",
                limit: {
                  context: 128000,
                  output: 8192,
                },
              },
            },
          },
        },
      },
      null,
      2,
    ),
  );

  const logger = createTestLogger();
  const runtimeSettings = {
    env: {
      XDG_CONFIG_HOME: xdgConfigHome,
      XDG_DATA_HOME: xdgDataHome,
      XDG_CACHE_HOME: xdgCacheHome,
      OPENCODE_DISABLE_AUTO_UPDATE: "1",
    },
  };
  const client = new OpenCodeAgentClient(logger, runtimeSettings);
  const events: AgentStreamEvent[] = [];
  const eventLog: Array<{ elapsedMs: number; event: AgentStreamEvent }> = [];
  let session: Awaited<ReturnType<OpenCodeAgentClient["createSession"]>> | undefined;

  try {
    session = await client.createSession({
      provider: "opencode",
      cwd: projectDir,
      model: "flaky/flaky-model",
    });
    session.subscribe((event) => {
      events.push(event);
      eventLog.push({ elapsedMs: Date.now() - turnStartedAt, event });
    });

    turnStartedAt = Date.now();
    await session.startTurn("Say hello.");
    await new Promise((resolve) => setTimeout(resolve, 12_000));

    const retryEvents = events.filter(
      (event) => event.type === "timeline" && event.item.type === "error",
    );
    expect(retryEvents.length).toBeGreaterThan(0);

    const failedEvents = events.filter((event) => event.type === "turn_failed");
    expect(
      failedEvents,
      JSON.stringify(
        { completionRequests, requestLog, eventLog, failedEvents, retryEvents },
        null,
        2,
      ),
    ).toEqual([]);
  } finally {
    await session?.close();
    await OpenCodeServerManager.getInstance(logger, runtimeSettings).shutdown();
    providerServer.close();
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);
