import type pino from "pino";

import type { PushPayload } from "./push-service.js";

const SERVERCHAN_BASE_URL = "https://sctapi.ftqq.com";
const SERVERCHAN_SEND_TIMEOUT_MS = 10_000;

export interface ServerChanOptions {
  sendKey?: string | null;
  fetchImpl?: typeof fetch;
}

export class ServerChanService {
  private readonly logger: pino.Logger;
  private readonly sendKey: string | null;
  private readonly fetchImpl: typeof fetch;

  constructor(logger: pino.Logger, options: ServerChanOptions = {}) {
    this.logger = logger.child({ component: "serverchan-service" });
    this.sendKey = normalizeSendKey(options.sendKey ?? process.env["PASEO_SERVERCHAN_SENDKEY"]);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get enabled(): boolean {
    return this.sendKey !== null;
  }

  async send(payload: PushPayload): Promise<void> {
    if (!this.sendKey) {
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SERVERCHAN_SEND_TIMEOUT_MS);

    try {
      const response = await this.fetchImpl(`${SERVERCHAN_BASE_URL}/${this.sendKey}.send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        },
        body: encodePayload(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        this.logger.warn(
          { status: response.status, statusText: response.statusText },
          "ServerChan notification failed",
        );
      }
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to send ServerChan notification");
    } finally {
      clearTimeout(timeout);
    }
  }
}

function normalizeSendKey(sendKey: string | null | undefined): string | null {
  const normalized = sendKey?.trim();
  return normalized ? normalized : null;
}

function encodePayload(payload: PushPayload): URLSearchParams {
  const params = new URLSearchParams();
  params.set("title", payload.title);
  params.set("desp", payload.body);
  params.set("short", payload.body);
  return params;
}
