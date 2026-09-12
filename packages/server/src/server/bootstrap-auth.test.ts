import { WebSocket } from "ws";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { buildBearerSubprotocols } from "@getpaseo/protocol/daemon-bearer";

import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";

const originalEnv = { ...process.env };
const CORRECT_PASSWORD_HASH = "$2b$12$OLxyuuP9uLK30Uzc4wQX0O6liuU/Q1t5P2b0Ebf36mULvpVK3DRZW";
// `@`, `/`, `=` and the space are all illegal in a WebSocket subprotocol.
const AWKWARD_PASSWORD = "corr@ct/horse=battery staple";
const AWKWARD_PASSWORD_HASH = "$2b$12$EvTObmPq.JuhrAYjevGwDeDXVH38Ddui4aCGW23Vfup3OKD40T/Pu";

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
}): Promise<void> {
  const { ws } = await connectWebSocket(params);
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
      ws.close();
    } finally {
      await daemonHandle.close();
    }
  });

  test("authenticates a password that cannot travel as a verbatim subprotocol", async () => {
    const daemonHandle = await createTestPaseoDaemon({
      auth: { password: AWKWARD_PASSWORD_HASH },
    });
    try {
      // The verbatim form never reaches the daemon: the WebSocket constructor
      // rejects the subprotocol before opening a connection.
      expect(
        () =>
          new WebSocket(`ws://127.0.0.1:${daemonHandle.port}/ws`, [
            `paseo.bearer.${AWKWARD_PASSWORD}`,
          ]),
      ).toThrow(SyntaxError);

      const [encoded] = buildBearerSubprotocols(AWKWARD_PASSWORD);
      const { ws, protocol } = await connectWebSocket({
        port: daemonHandle.port,
        protocol: encoded,
      });
      expect(protocol).toBe(encoded);
      ws.close();
    } finally {
      await daemonHandle.close();
    }
  });
});
