import { WebSocket } from "ws";
import { describe, expect, test } from "vitest";

import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";

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

async function expectWebSocketRejects(params: {
  port: number;
  protocol?: string;
  statusCode: number;
}): Promise<void> {
  await expect(connectWebSocket(params)).rejects.toMatchObject({
    message: `Unexpected server response: ${params.statusCode}`,
  });
}

describe("daemon bearer auth", () => {
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
      auth: { password: "correct-password" },
    });
    try {
      const missing = await fetch(`http://127.0.0.1:${daemonHandle.port}/api/files/download`);
      expect(missing.status).toBe(401);

      const wrong = await fetch(`http://127.0.0.1:${daemonHandle.port}/api/files/download`, {
        headers: { Authorization: "Bearer wrong-password" },
      });
      expect(wrong.status).toBe(401);

      const correct = await fetch(`http://127.0.0.1:${daemonHandle.port}/api/files/download`, {
        headers: { Authorization: "Bearer correct-password" },
      });
      expect(correct.status).toBe(400);
    } finally {
      await daemonHandle.close();
    }
  });

  test("bypasses bearer auth for preflight and liveness endpoints", async () => {
    const daemonHandle = await createTestPaseoDaemon({
      auth: { password: "correct-password" },
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
      expect(status.status).toBe(200);
    } finally {
      await daemonHandle.close();
    }
  });

  test("requires paseo.bearer subprotocol on WebSocket upgrades when password is configured", async () => {
    const daemonHandle = await createTestPaseoDaemon({
      auth: { password: "correct-password" },
    });
    try {
      await expectWebSocketRejects({
        port: daemonHandle.port,
        statusCode: 401,
      });
      await expectWebSocketRejects({
        port: daemonHandle.port,
        protocol: "paseo.bearer.wrong-password",
        statusCode: 401,
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
});
