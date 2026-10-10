import { afterEach, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTerminalManager, type TerminalManager } from "../terminal/terminal-manager.js";
import { createWorkerTerminalManager } from "../terminal/worker-terminal-manager.js";
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
let server: Server | null = null;
const temporaryDirs: string[] = [];

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    server = null;
  }
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

it("keeps newer terminal activity when delayed reports arrive through HTTP and the worker", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "terminal-activity-route-"));
  temporaryDirs.push(cwd);
  const envPath = join(cwd, "activity-env.json");
  manager = createWorkerTerminalManager({
    getTerminalActivityUrl: () => "http://127.0.0.1:6767/api/terminal-activity",
  });

  const session = await manager.createTerminal({
    cwd,
    workspaceId: "activity-route-test",
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
  const handler = createTerminalActivityRouteHandler(manager);
  const app = express();
  app.use(express.json());
  app.post("/api/terminal-activity", handler);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an HTTP listening address");
  }
  const url = `http://127.0.0.1:${address.port}/api/terminal-activity`;
  async function reportActivity(body: Record<string, unknown>): Promise<Response> {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ terminalId: env.terminalId, token: env.token, ...body }),
    });
  }

  expect(env.terminalId).toBe(session.id);
  expect(env.url).toBe("http://127.0.0.1:6767/api/terminal-activity");
  expect((await reportActivity({ state: "running" })).status).toBe(204);
  expect(session.getActivity()?.state).toBe("working");
  expect((await reportActivity({ state: "running", at_ns: 1791586800000000000 })).status).toBe(204);
  expect((await reportActivity({ state: "running", at_ns: "1791586800000000001" })).status).toBe(
    204,
  );
  expect((await reportActivity({ state: "idle", at_ns: "1791586800000000000" })).status).toBe(204);
  expect(session.getActivity()?.state).toBe("working");

  expect((await reportActivity({ state: "idle", at_ns: "1791586800000000002" })).status).toBe(204);
  const finished = session.getActivity();
  expect(finished).toMatchObject({ state: "idle", attentionReason: "finished" });
  expect(
    (await reportActivity({ state: "needs-input", at_ns: "1791586800000000002" })).status,
  ).toBe(204);
  expect(session.getActivity()).toEqual(finished);

  await manager.clearTerminalAttention(session.id);
  const reviewed = session.getActivity();
  expect(reviewed).toMatchObject({ state: "idle" });
  expect(reviewed?.attentionReason).toBeUndefined();
  expect((await reportActivity({ state: "idle", at_ns: "1791586800000000002" })).status).toBe(204);
  expect(session.getActivity()).toEqual(reviewed);

  expect((await reportActivity({ state: "running", at_ns: "1791586800000000003" })).status).toBe(
    204,
  );
  expect((await reportActivity({ state: "running", at_ns: "1791586800000000005" })).status).toBe(
    204,
  );
  expect((await reportActivity({ state: "idle", at_ns: "1791586800000000004" })).status).toBe(204);
  expect(session.getActivity()?.state).toBe("working");
  session.setActivity("idle", "1791586800000000004");
  await manager.setTerminalActivity(session.id, "working", "1791586800000000005");
  expect(session.getActivity()?.state).toBe("working");
  expect((await reportActivity({ state: "idle", at_ns: "invalid" })).status).toBe(400);
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
