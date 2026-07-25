import { WebSocket } from "ws";
import { z } from "zod";
import type { WebSocketLike } from "../websocket-server.js";

export interface HubEnrollment {
  daemonId: string;
  idempotencyKey: string;
  hubOrigin: string;
  token: string;
  serverId: string;
  daemonPublicKey: string;
  credentialVerifier: string;
  scopes: string[];
}

export interface HubEnrollmentResult {
  daemonId: string;
  scopes: string[];
  webSocketUrl: string;
}

export interface HubRevocation {
  daemonId: string;
  hubOrigin: string;
  credential: string;
}

export interface HubSocketCredentials {
  daemonId: string;
  webSocketUrl: string;
  credential: string;
}

export interface HubSocketEvents {
  connected(socket: WebSocketLike): void;
  rejected(statusCode: 401 | 403): void;
  closed(code: number): void;
  failed(error: Error): void;
}

export interface HubSocketConnection {
  close(): void;
}

export interface HubRelationshipRemote {
  enroll(input: HubEnrollment): Promise<HubEnrollmentResult>;
  revoke(input: HubRevocation): Promise<void>;
  openSocket(input: HubSocketCredentials, events: HubSocketEvents): HubSocketConnection;
}

export class HubEnrollmentRejectedError extends Error {
  constructor(readonly statusCode: number) {
    super(`Hub enrollment failed (${statusCode})`);
    this.name = "HubEnrollmentRejectedError";
  }
}

const EnrollmentResultSchema = z.object({
  daemonId: z.string(),
  scopes: z.array(z.string()),
  webSocketUrl: z
    .string()
    .url()
    .refine((value) => ["ws:", "wss:"].includes(new URL(value).protocol), {
      message: "Hub WebSocket URL must use ws or wss",
    })
    .refine((value) => new URL(value).hash === "", {
      message: "Hub WebSocket URL cannot include a fragment",
    }),
});

function ensureWebSocketMatchesHubOrigin(hubOrigin: string, webSocketUrl: string): void {
  const hub = new URL(hubOrigin);
  const socket = new URL(webSocketUrl);
  const expectedProtocol = hub.protocol === "https:" ? "wss:" : "ws:";
  if (socket.protocol !== expectedProtocol || socket.host !== hub.host) {
    throw new Error("Hub WebSocket URL must match the Hub origin");
  }
}

export class DirectHubRelationshipRemote implements HubRelationshipRemote {
  private readonly requestTimeoutMs: number;

  constructor(options: { requestTimeoutMs?: number } = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  }

  async enroll(input: HubEnrollment): Promise<HubEnrollmentResult> {
    return this.withRequestTimeout(async (signal) => {
      const response = await fetch(`${input.hubOrigin}/api/daemons/enroll`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${input.token}`,
        },
        body: JSON.stringify({
          daemonId: input.daemonId,
          idempotencyKey: input.idempotencyKey,
          serverId: input.serverId,
          daemonPublicKey: input.daemonPublicKey,
          credentialVerifier: input.credentialVerifier,
          scopes: input.scopes,
        }),
        signal,
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new HubEnrollmentRejectedError(response.status);
        }
        throw new Error(`Hub enrollment failed (${response.status})`);
      }
      const enrollment = EnrollmentResultSchema.parse(await response.json());
      ensureWebSocketMatchesHubOrigin(input.hubOrigin, enrollment.webSocketUrl);
      return enrollment;
    });
  }

  async revoke(input: HubRevocation): Promise<void> {
    await this.withRequestTimeout(async (signal) => {
      const response = await fetch(
        `${input.hubOrigin}/api/daemons/${encodeURIComponent(input.daemonId)}`,
        {
          method: "DELETE",
          headers: { authorization: `Bearer ${input.credential}` },
          signal,
        },
      );
      if (!response.ok && ![401, 403, 404].includes(response.status)) {
        throw new Error(`Hub revocation failed (${response.status})`);
      }
    });
  }

  openSocket(input: HubSocketCredentials, events: HubSocketEvents): HubSocketConnection {
    const socket = new WebSocket(input.webSocketUrl, {
      handshakeTimeout: this.requestTimeoutMs,
      headers: {
        authorization: `Bearer ${input.credential}`,
        "x-paseo-daemon-id": input.daemonId,
      },
    });
    let settled = false;
    socket.once("open", () => {
      if (!settled) events.connected(socket as WebSocketLike);
    });
    socket.once("unexpected-response", (_request, response) => {
      if (settled) {
        response.destroy();
        return;
      }
      settled = true;
      response.destroy();
      socket.terminate();
      if (response.statusCode === 401 || response.statusCode === 403) {
        events.rejected(response.statusCode);
        return;
      }
      events.closed(1006);
    });
    socket.once("close", (code) => {
      if (settled) return;
      settled = true;
      events.closed(code);
    });
    socket.once("error", (error) => {
      if (settled) return;
      settled = true;
      socket.terminate();
      events.failed(error);
    });
    return socket;
  }

  private async withRequestTimeout<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timeout.unref?.();
    try {
      return await operation(controller.signal);
    } catch (error) {
      if (controller.signal.aborted) throw new Error("Hub request timed out", { cause: error });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
