import { afterEach, expect, it } from "vitest";
import type express from "express";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTerminalManager, type TerminalManager } from "../terminal/terminal-manager.js";
import { createTerminalActivityRouteHandler } from "./bootstrap.js";

interface MockResponse {
  statusCode: number;
  body: unknown;
  ended: boolean;
  status(code: number): MockResponse;
  json(body: unknown): MockResponse;
  end(): MockResponse;
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 25,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

function createMockResponse(): MockResponse {
  return {
    statusCode: 200,
    body: undefined,
    ended: false,
    status(code: number): MockResponse {
      this.statusCode = code;
      return this;
    },
    json(body: unknown): MockResponse {
      this.body = body;
      this.ended = true;
      return this;
    },
    end(): MockResponse {
      this.ended = true;
      return this;
    },
  };
}

function createMockRequest(input: { body: unknown; remoteAddress?: string }): express.Request {
  return {
    body: input.body,
    socket: {
      remoteAddress: input.remoteAddress ?? "127.0.0.1",
    },
  } as express.Request;
}

let manager: TerminalManager | null = null;
const temporaryDirs: string[] = [];

afterEach(async () => {
  if (manager) {
    const terminalsByCwd = await Promise.all(
      manager.listDirectories().map((cwd) => manager!.getTerminals(cwd)),
    );
    for (const terminal of terminalsByCwd.flat()) {
      await manager.killTerminalAndWait(terminal.id);
    }
    manager.killAll();
    manager = null;
  }
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

it("accepts terminalId and token reports through the route into the tracker", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "terminal-activity-route-"));
  temporaryDirs.push(cwd);
  const envPath = join(cwd, "activity-env.json");
  manager = createTerminalManager({
    getTerminalActivityUrl: () => "http://127.0.0.1:6767/api/terminal-activity",
  });

  const session = await manager.createTerminal({
    cwd,
    command: process.execPath,
    args: [
      "-e",
      `require("node:fs").writeFileSync(${JSON.stringify(envPath)}, JSON.stringify({ terminalId: process.env.PASEO_TERMINAL_ID, token: process.env.PASEO_ACTIVITY_TOKEN, url: process.env.PASEO_TERMINAL_ACTIVITY_URL })); setInterval(() => {}, 1000);`,
    ],
  });
  await waitForCondition(() => existsSync(envPath), 10000);
  const env = JSON.parse(readFileSync(envPath, "utf8")) as {
    terminalId: string;
    token: string;
    url: string;
  };
  const response = createMockResponse();
  const handler = createTerminalActivityRouteHandler(manager);

  await handler(
    createMockRequest({ body: { terminalId: env.terminalId, token: env.token, state: "running" } }),
    response as unknown as express.Response,
    () => undefined,
  );

  expect(env.terminalId).toBe(session.id);
  expect(env.url).toBe("http://127.0.0.1:6767/api/terminal-activity");
  expect(response.statusCode).toBe(204);
  expect(session.getActivity()?.state).toBe("working");
});

it("rejects non-loopback activity reports before token handling", async () => {
  manager = createTerminalManager();
  const response = createMockResponse();
  const handler = createTerminalActivityRouteHandler(manager);

  await handler(
    createMockRequest({
      body: { terminalId: "terminal-1", token: "token", state: "running" },
      remoteAddress: "192.168.1.5",
    }),
    response as unknown as express.Response,
    () => undefined,
  );

  expect(response.statusCode).toBe(403);
});

it("uses one rejection for unknown terminals and wrong tokens", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "terminal-activity-route-"));
  temporaryDirs.push(cwd);
  manager = createTerminalManager();
  const session = await manager.createTerminal({ cwd });
  const handler = createTerminalActivityRouteHandler(manager);
  const unknownResponse = createMockResponse();
  const invalidResponse = createMockResponse();

  await handler(
    createMockRequest({ body: { terminalId: "unknown", token: "bad", state: "running" } }),
    unknownResponse as unknown as express.Response,
    () => undefined,
  );
  await handler(
    createMockRequest({ body: { terminalId: session.id, token: "bad", state: "running" } }),
    invalidResponse as unknown as express.Response,
    () => undefined,
  );

  expect(unknownResponse.statusCode).toBe(403);
  expect(invalidResponse.statusCode).toBe(403);
  expect(unknownResponse.body).toEqual(invalidResponse.body);
});
