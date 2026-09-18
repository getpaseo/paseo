import { WebSocket } from "ws";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FLEET_CONTROL_PORTFOLIO_AGENT_ID,
  FleetCommitmentReadResponseSchema,
} from "@getpaseo/protocol/fleet-control";
import { WSOutboundMessageSchema, type WSOutboundMessage } from "@getpaseo/protocol/messages";

import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { hashDaemonPassword } from "./auth.js";

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

function waitForWsMessage(
  ws: WebSocket,
  matches: (message: WSOutboundMessage) => boolean,
): Promise<WSOutboundMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for WebSocket message")),
      5_000,
    );
    const listener = (data: WebSocket.RawData) => {
      const parsed = WSOutboundMessageSchema.safeParse(JSON.parse(data.toString()));
      if (!parsed.success || !matches(parsed.data)) return;
      clearTimeout(timeout);
      ws.off("message", listener);
      resolve(parsed.data);
    };
    ws.on("message", listener);
  });
}

async function sendHello(ws: WebSocket, clientId: string): Promise<WSOutboundMessage> {
  const response = waitForWsMessage(
    ws,
    (message) =>
      message.type === "session" &&
      message.message.type === "status" &&
      message.message.payload.status === "server_info",
  );
  ws.send(JSON.stringify({ type: "hello", clientId, clientType: "cli", protocolVersion: 1 }));
  return response;
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

  test("admits Deck over a real WebSocket while owner cannot call Fleet handlers", async () => {
    const paseoHomeRoot = await mkdtemp(join(tmpdir(), "paseo-deck-ws-"));
    const ledgerPath = join(paseoHomeRoot, "fleet.md");
    const commitmentId = "64e89b9a-ff01-4cd8-b3f8-202bd276bc1d";
    await writeFile(
      ledgerPath,
      `| ${commitmentId} | Target | owner | active | now | evidence | <!--["fleet-control.v1","${commitmentId}","open",0,null,"${FLEET_CONTROL_PORTFOLIO_AGENT_ID}"]-->remaining |\n`,
    );
    const daemonHandle = await createTestPaseoDaemon({
      paseoHomeRoot,
      auth: {
        password: CORRECT_PASSWORD_HASH,
        firstmateDeckCredential: hashDaemonPassword("deck-password"),
      },
      fleetCommitmentControls: { ledgerPath },
    });
    try {
      const { ws: owner } = await connectWebSocket({
        port: daemonHandle.port,
        protocol: "paseo.bearer.correct-password",
      });
      const ownerInfo = await sendHello(owner, "owner-client");
      expect(ownerInfo).toMatchObject({
        type: "session",
        message: { payload: { permissions: expect.not.arrayContaining(["fleet.control"]) } },
      });
      const ownerDenied = waitForWsMessage(
        owner,
        (message) =>
          message.type === "session" &&
          message.message.type === "rpc_error" &&
          message.message.payload.requestId === "owner-confirm",
      );
      owner.send(
        JSON.stringify({
          type: "session",
          message: {
            type: "fleet.commitment.confirm.request",
            requestId: "owner-confirm",
            operationRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            commitmentId,
          },
        }),
      );
      await expect(ownerDenied).resolves.toMatchObject({
        message: { payload: { code: "access_denied" } },
      });

      const { ws: deck } = await connectWebSocket({
        port: daemonHandle.port,
        protocol: "paseo.bearer.deck-password",
      });
      const deckInfo = await sendHello(deck, "deck-client");
      expect(deckInfo).toMatchObject({
        type: "session",
        message: {
          payload: {
            permissions: ["fleet.control"],
            features: { fleetCommitmentControls: true },
          },
        },
      });
      const deckRead = waitForWsMessage(
        deck,
        (message) =>
          message.type === "session" && message.message.type === "fleet.commitment.read.response",
      );
      deck.send(
        JSON.stringify({
          type: "session",
          message: {
            type: "fleet.commitment.read.request",
            requestId: "deck-read",
            commitmentId,
          },
        }),
      );
      const response = await deckRead;
      if (response.type !== "session") throw new Error("Expected session response");
      expect(FleetCommitmentReadResponseSchema.parse(response.message).payload).toMatchObject({
        requestId: "deck-read",
        commitmentId,
      });
      owner.close();
      deck.close();
    } finally {
      await daemonHandle.close();
    }
  });
});
