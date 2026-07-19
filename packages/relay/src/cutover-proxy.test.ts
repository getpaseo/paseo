import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import relayWorker from "./cloudflare-adapter.js";

type RelayEnv = Parameters<typeof relayWorker.fetch>[1];

interface ReceivedRequest {
  method: string;
  path: string;
  probe: string;
}

class RecordingOrigin {
  private readonly requests: ReceivedRequest[] = [];
  private server: Server | null = null;

  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      this.requests.push(recordRequest(request));
      response.writeHead(202, { "content-type": "application/json", "x-relay-origin": "fly" });
      response.end(JSON.stringify({ status: "forwarded" }));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  received(): ReceivedRequest[] {
    return this.requests;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

function recordRequest(request: IncomingMessage): ReceivedRequest {
  return {
    method: request.method ?? "",
    path: request.url ?? "",
    probe: String(request.headers["x-relay-probe"] ?? ""),
  };
}

describe("cutover proxy", () => {
  const origins: RecordingOrigin[] = [];

  afterEach(async () => {
    await Promise.all(origins.splice(0).map((origin) => origin.close()));
  });

  it("forwards the request to the configured origin without changing its route", async () => {
    const origin = new RecordingOrigin();
    origins.push(origin);
    const originUrl = await origin.start();

    const response = await relayWorker.fetch(
      new Request("https://relay.paseo.sh/ws?serverId=srv_prod&role=server&v=2", {
        headers: { "x-relay-probe": "production" },
      }),
      { PASEO_RELAY_UPSTREAM: originUrl } as RelayEnv,
    );

    expect(origin.received()).toEqual([
      {
        method: "GET",
        path: "/ws?serverId=srv_prod&role=server&v=2",
        probe: "production",
      },
    ]);
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ status: "forwarded" });
    expect(response.headers.get("x-relay-origin")).toBe("fly");
  });
});
