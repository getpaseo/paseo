import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { CodexAppServerAgentClient } from "./codex-app-server-agent.js";

// Runs the real `codex` binary against a local Responses endpoint standing in
// for a custom provider's OPENAI_BASE_URL, so no login is needed.

function sse(events: Array<Record<string, unknown>>): string {
  return events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

function finalAnswer(): string {
  return sse([
    { type: "response.created", response: { id: "resp-1" } },
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        id: "msg-1",
        content: [{ type: "output_text", text: "done" }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: "resp-1",
        usage: {
          input_tokens: 0,
          input_tokens_details: null,
          output_tokens: 0,
          output_tokens_details: null,
          total_tokens: 0,
        },
      },
    },
  ]);
}

async function startResponsesEndpoint(): Promise<{
  baseUrl: string;
  server: Server;
  requestCount: () => number;
}> {
  let requests = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== "/v1/responses") {
        res.statusCode = 404;
        res.end();
        return;
      }
      requests += 1;
      res.setHeader("content-type", "text/event-stream");
      res.end(finalAnswer());
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no server address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    server,
    requestCount: () => requests,
  };
}

async function closeServer(server: Server): Promise<void> {
  server.close();
  await once(server, "close");
}

describe("Codex custom provider import list", () => {
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  });

  test("lists a custom provider's session under that provider and imports it there", async () => {
    const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-custom-import-home-"));
    const cwd = mkdtempSync(path.join(os.tmpdir(), "codex-custom-import-cwd-"));
    cleanups.push(() => rmSync(codexHome, { recursive: true, force: true }));
    cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
    const { baseUrl, server, requestCount } = await startResponsesEndpoint();
    cleanups.push(() => closeServer(server));

    const logger = createTestLogger();
    const customCodex = new CodexAppServerAgentClient(
      logger,
      { env: { CODEX_HOME: codexHome, OPENAI_BASE_URL: baseUrl, OPENAI_API_KEY: "test-key" } },
      { customProvider: { id: "my-codex", label: "My Codex", extends: "codex" } },
    );
    const stockCodex = new CodexAppServerAgentClient(logger, { env: { CODEX_HOME: codexHome } });

    const session = await customCodex.createSession({
      provider: "codex",
      cwd,
      model: "mock-model",
    });
    try {
      await session.run("hello from the custom provider");
    } finally {
      await session.close();
    }

    const customSessions = await customCodex.listImportableSessions({ cwd });
    const stockSessions = await stockCodex.listImportableSessions({ cwd });

    expect(customSessions.map((entry) => entry.firstPromptPreview)).toEqual([
      "hello from the custom provider",
    ]);
    expect(stockSessions).toEqual([]);

    const config = { provider: "codex", cwd, model: "mock-model" };
    const imported = await customCodex.importSession(
      { providerHandleId: customSessions[0].providerHandleId, cwd },
      { config, storedConfig: config },
    );
    const requestsBeforeImportedTurn = requestCount();
    try {
      await imported.session.run("hello again after import");
    } finally {
      await imported.session.close();
    }
    expect(requestCount()).toBeGreaterThan(requestsBeforeImportedTurn);
  }, 120_000);
});
