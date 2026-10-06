import { WebSocket } from "ws";
import { hash } from "bcryptjs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { DaemonAuthenticationError, DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { readLocalCredentialForTarget } from "./local-credential.js";

const originalEnv = { ...process.env };
const CORRECT_PASSWORD_HASH = "$2b$12$OLxyuuP9uLK30Uzc4wQX0O6liuU/Q1t5P2b0Ebf36mULvpVK3DRZW";

function connectWebSocket(params: {
  port: number;
  protocol?: string;
}): Promise<{ ws: WebSocket; protocol: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${params.port}/ws`,
      params.protocol ? [params.protocol] : undefined,
    );
    ws.once("open", () => resolve({ ws, protocol: ws.protocol }));
    ws.once("error", reject);
  });
}

async function expectWebSocketCloses(params: {
  port: number;
  protocol?: string;
  code: number;
  reason: string;
  hello?: Record<string, unknown>;
}): Promise<void> {
  const { ws } = await connectWebSocket(params);
  if (params.hello) ws.send(JSON.stringify(params.hello));
  await expect(
    new Promise<{ code: number; reason: string }>((resolve) => {
      ws.once("close", (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
    }),
  ).resolves.toEqual({
    code: params.code,
    reason: params.reason,
  });
}

describe("daemon bearer auth", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    process.env = { ...originalEnv, PASEO_SUPERVISED: "0" };
  });

  test("leaves HTTP and WebSocket open when no password is configured", async () => {
    const daemonHandle = await createTestPaseoDaemon();
    try {
      const response = await fetch(`http://127.0.0.1:${daemonHandle.port}/api/status`);
      expect(response.status).toBe(200);

      const { ws, protocol } = await connectWebSocket({ port: daemonHandle.port });
      expect(protocol).toBe("");
      ws.close();
    } finally {
      await daemonHandle.close();
    }
  });

  test("requires Authorization bearer on protected HTTP routes when password is configured", async () => {
    const daemonHandle = await createTestPaseoDaemon({
      auth: { password: CORRECT_PASSWORD_HASH },
    });
    try {
      const missing = await fetch(`http://127.0.0.1:${daemonHandle.port}/api/status`);
      expect(missing.status).toBe(401);

      const wrong = await fetch(`http://127.0.0.1:${daemonHandle.port}/api/status`, {
        headers: { Authorization: "Bearer wrong-password" },
      });
      expect(wrong.status).toBe(401);

      const correct = await fetch(`http://127.0.0.1:${daemonHandle.port}/api/status`, {
        headers: { Authorization: "Bearer correct-password" },
      });
      expect(correct.status).toBe(200);

      const localToken = (
        await readFile(join(daemonHandle.paseoHome, "local-credential"), "utf8")
      ).trim();
      const local = await fetch(`http://127.0.0.1:${daemonHandle.port}/api/status`, {
        headers: { Authorization: `Bearer ${localToken}` },
      });
      expect(local.status).toBe(200);
    } finally {
      await daemonHandle.close();
    }
  });

  test("allows file downloads with only a capability token when password is configured", async () => {
    const daemonHandle = await createTestPaseoDaemon({
      auth: { password: CORRECT_PASSWORD_HASH },
    });
    try {
      // No bearer at all: the route is reachable, but the download token store
      // rejects the request because no token was supplied (400, not 401).
      const missingToken = await fetch(`http://127.0.0.1:${daemonHandle.port}/api/files/download`);
      expect(missingToken.status).toBe(400);

      // An invalid token is rejected by the token store (403, not 401) — proving
      // the token, not the daemon password, is what guards this route.
      const invalidToken = await fetch(
        `http://127.0.0.1:${daemonHandle.port}/api/files/download?token=invalid-token`,
      );
      expect(invalidToken.status).toBe(403);
    } finally {
      await daemonHandle.close();
    }
  });

  test("bypasses bearer auth for preflight and liveness endpoints", async () => {
    const daemonHandle = await createTestPaseoDaemon({
      auth: { password: CORRECT_PASSWORD_HASH },
    });
    try {
      const preflight = await fetch(`http://127.0.0.1:${daemonHandle.port}/api/files/download`, {
        method: "OPTIONS",
        headers: { Origin: "https://app.paseo.sh" },
      });
      expect(preflight.status).toBe(204);

      const health = await fetch(`http://127.0.0.1:${daemonHandle.port}/api/health`);
      expect(health.status).toBe(200);

      const status = await fetch(`http://127.0.0.1:${daemonHandle.port}/api/status`);
      expect(status.status).toBe(401);
    } finally {
      await daemonHandle.close();
    }
  });

  test("closes WebSocket connections with readable auth failures when password is configured", async () => {
    const daemonHandle = await createTestPaseoDaemon({
      auth: { password: CORRECT_PASSWORD_HASH },
    });
    try {
      await expectWebSocketCloses({
        port: daemonHandle.port,
        code: 4401,
        reason: "Password required",
        hello: { type: "hello", clientId: "missing", clientType: "cli", protocolVersion: 1 },
      });
      await expectWebSocketCloses({
        port: daemonHandle.port,
        protocol: "paseo.bearer.wrong-password",
        code: 4401,
        reason: "Incorrect password",
      });

      const { ws, protocol } = await connectWebSocket({
        port: daemonHandle.port,
        protocol: "paseo.bearer.correct-password",
      });
      expect(protocol).toBe("paseo.bearer.correct-password");
      const serverInfo = new Promise<unknown>((resolve) => {
        ws.once("message", (data) => resolve(JSON.parse(data.toString())));
      });
      ws.send(
        JSON.stringify({
          type: "hello",
          clientId: "legacy",
          clientType: "cli",
          protocolVersion: 1,
        }),
      );
      await expect(serverInfo).resolves.toMatchObject({
        type: "session",
        message: { payload: { status: "server_info" } },
      });
      ws.close();
    } finally {
      await daemonHandle.close();
    }
  });

  test("accepts hello password and local credential and reports the negotiated protocol", async () => {
    const daemonHandle = await createTestPaseoDaemon({ auth: { password: CORRECT_PASSWORD_HASH } });
    try {
      const token = (
        await readFile(join(daemonHandle.paseoHome, "local-credential"), "utf8")
      ).trim();
      if (process.platform !== "win32") {
        expect((await stat(join(daemonHandle.paseoHome, "local-credential"))).mode & 0o777).toBe(
          0o600,
        );
      }
      for (const auth of [
        { kind: "password", password: "correct-password" },
        { kind: "localCredential", token },
      ]) {
        const { ws } = await connectWebSocket({ port: daemonHandle.port });
        const serverInfo = new Promise<Record<string, unknown>>((resolve, reject) => {
          ws.once("message", (data) =>
            resolve(JSON.parse(data.toString()) as Record<string, unknown>),
          );
          ws.once("close", () => reject(new Error("closed before server_info")));
        });
        ws.send(
          JSON.stringify({
            type: "hello",
            clientId: `test-${auth.kind}`,
            clientType: "cli",
            protocolVersion: 2,
            auth,
          }),
        );
        await expect(serverInfo).resolves.toMatchObject({
          type: "session",
          message: { payload: { status: "server_info", protocolVersion: 1 } },
        });
        ws.close();
      }
    } finally {
      await daemonHandle.close();
    }
    await expect(
      readFile(join(daemonHandle.paseoHome, "local-credential"), "utf8"),
    ).rejects.toThrow();
  });

  test("uses the per-run credential in memory after the file changes", async () => {
    const daemonHandle = await createTestPaseoDaemon({ auth: { password: CORRECT_PASSWORD_HASH } });
    try {
      const path = join(daemonHandle.paseoHome, "local-credential");
      const token = (await readFile(path, "utf8")).trim();
      await writeFile(path, "stale-on-disk\n");
      const { ws } = await connectWebSocket({ port: daemonHandle.port });
      const serverInfo = new Promise<unknown>((resolve) => {
        ws.once("message", (data) => resolve(JSON.parse(data.toString())));
      });
      ws.send(
        JSON.stringify({
          type: "hello",
          clientId: "local-after-file-change",
          clientType: "cli",
          protocolVersion: 1,
          auth: { kind: "localCredential", token },
        }),
      );
      await expect(serverInfo).resolves.toMatchObject({
        type: "session",
        message: { payload: { status: "server_info" } },
      });
      ws.close();
    } finally {
      await daemonHandle.close();
    }
  });

  test("a desktop-style client connects to its password-protected local daemon without a saved password", async () => {
    const daemonHandle = await createTestPaseoDaemon({ auth: { password: CORRECT_PASSWORD_HASH } });
    const target = `127.0.0.1:${daemonHandle.port}`;
    await writeFile(join(daemonHandle.paseoHome, "paseo.pid"), JSON.stringify({ listen: target }));
    const client = new DaemonClient({
      url: `ws://${target}/ws`,
      clientId: "desktop-managed-test",
      clientType: "browser",
      localCredential: async () =>
        readLocalCredentialForTarget(daemonHandle.paseoHome, target) ?? undefined,
      webSocketFactory: (url, options) =>
        new WebSocket(url, options?.protocols, { headers: options?.headers }),
      reconnect: { enabled: false },
    });
    try {
      await client.connect();
      expect(client.getLastServerInfoMessage()?.serverId).toBe(daemonHandle.daemon.getServerId());
    } finally {
      await client.close();
      await daemonHandle.close();
    }
  });

  test("rejects a wrong hello password with a protocol frame before close", async () => {
    const daemonHandle = await createTestPaseoDaemon({ auth: { password: CORRECT_PASSWORD_HASH } });
    try {
      const { ws } = await connectWebSocket({ port: daemonHandle.port });
      const frames: unknown[] = [];
      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.on("message", (data) => frames.push(JSON.parse(data.toString())));
        ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
      });
      ws.send(
        JSON.stringify({
          type: "hello",
          clientId: "wrong",
          clientType: "cli",
          protocolVersion: 1,
          auth: { kind: "password", password: "wrong" },
        }),
      );
      await expect(closed).resolves.toEqual({ code: 4401, reason: "Incorrect password" });
      expect(frames).toEqual([
        { type: "hello.rejected", reason: "incorrect_password", accepts: ["password"] },
      ]);
    } finally {
      await daemonHandle.close();
    }
  });

  test("surfaces a typed auth reason from a real client with the wrong password", async () => {
    const daemonHandle = await createTestPaseoDaemon({ auth: { password: CORRECT_PASSWORD_HASH } });
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemonHandle.port}/ws`,
      clientId: "typed-wrong-password",
      clientType: "browser",
      password: "wrong password",
      webSocketFactory: (url, options) =>
        new WebSocket(url, options?.protocols, { headers: options?.headers }),
      reconnect: { enabled: false },
    });
    try {
      await expect(client.connect()).rejects.toMatchObject({
        name: "DaemonAuthenticationError",
        reason: "incorrect_password",
      } satisfies Partial<DaemonAuthenticationError>);
    } finally {
      await client.close();
      await daemonHandle.close();
    }
  });

  test("authenticates a real browser client when its password is invalid as a WebSocket subprotocol", async () => {
    const password = "two words";
    const daemonHandle = await createTestPaseoDaemon({
      auth: { password: await hash(password, 4) },
    });
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemonHandle.port}/ws`,
      clientId: "browser-password-with-spaces",
      clientType: "browser",
      password,
      webSocketFactory: (url, options) =>
        new WebSocket(url, options?.protocols, { headers: options?.headers }),
      reconnect: { enabled: false },
    });
    try {
      await client.connect();
      expect(client.getLastServerInfoMessage()?.serverId).toBeTruthy();
    } finally {
      await client.close();
      await daemonHandle.close();
    }
  });

  test("ignores a proxy Basic header and admits the hello password", async () => {
    const daemonHandle = await createTestPaseoDaemon({ auth: { password: CORRECT_PASSWORD_HASH } });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${daemonHandle.port}/ws`, undefined, {
        headers: { Authorization: "Basic proxy-credential" },
      });
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      const info = new Promise<unknown>((resolve) => {
        ws.once("message", (frame) => resolve(JSON.parse(frame.toString())));
      });
      ws.send(
        JSON.stringify({
          type: "hello",
          clientId: "behind-basic-proxy",
          clientType: "cli",
          protocolVersion: 1,
          auth: { kind: "password", password: "correct-password" },
        }),
      );
      await expect(info).resolves.toMatchObject({
        type: "session",
        message: { payload: { status: "server_info" } },
      });
      ws.close();
    } finally {
      await daemonHandle.close();
    }
  });

  test("sends password_required to a capable client without a credential", async () => {
    const daemonHandle = await createTestPaseoDaemon({ auth: { password: CORRECT_PASSWORD_HASH } });
    try {
      const { ws } = await connectWebSocket({ port: daemonHandle.port });
      const frames: unknown[] = [];
      const closed = new Promise<number>((resolve) => {
        ws.on("message", (data) => frames.push(JSON.parse(data.toString())));
        ws.once("close", (code) => resolve(code));
      });
      ws.send(
        JSON.stringify({
          type: "hello",
          clientId: "capable",
          clientType: "cli",
          protocolVersion: 1,
          capabilities: { hello_rejection: true },
        }),
      );
      await expect(closed).resolves.toBe(4401);
      expect(frames).toEqual([
        { type: "hello.rejected", reason: "password_required", accepts: ["password"] },
      ]);
    } finally {
      await daemonHandle.close();
    }
  });

  test("closes a pre-hello ping without sending server data", async () => {
    const daemonHandle = await createTestPaseoDaemon({ auth: { password: CORRECT_PASSWORD_HASH } });
    try {
      const { ws } = await connectWebSocket({ port: daemonHandle.port });
      const frames: unknown[] = [];
      const closed = new Promise<number>((resolve) => {
        ws.on("message", (data) => frames.push(JSON.parse(data.toString())));
        ws.once("close", (code) => resolve(code));
      });
      ws.send(JSON.stringify({ type: "ping" }));
      await expect(closed).resolves.toBe(4002);
      expect(frames).toEqual([]);
    } finally {
      await daemonHandle.close();
    }
  });
});
