import { randomBytes, randomUUID } from "node:crypto";

import type { WeChatGetUpdatesResponse, WeChatMessage } from "./types.js";

const DEFAULT_QR_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_API_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const ILINK_APP_ID = "bot";
const ILINK_APP_CLIENT_VERSION = "0";

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function randomWechatUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf8").toString("base64");
}

function createAbortSignal(timeoutMs: number): AbortSignal | undefined {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return undefined;
  }
  return AbortSignal.timeout(timeoutMs);
}

function buildCommonHeaders(): Record<string, string> {
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": ILINK_APP_CLIENT_VERSION,
  };
}

function buildAuthedHeaders(token?: string, body?: string): Record<string, string> {
  return {
    ...buildCommonHeaders(),
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    ...(typeof body === "string"
      ? {
          "Content-Length": String(Buffer.byteLength(body, "utf8")),
        }
      : {}),
    ...(token?.trim()
      ? {
          Authorization: `Bearer ${token.trim()}`,
        }
      : {}),
  };
}

async function fetchText(url: string, init: RequestInit): Promise<string> {
  const response = await fetch(url, init);
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`WeChat API ${response.status}: ${raw}`);
  }
  return raw;
}

export async function startQrLogin(options?: {
  qrApiBaseUrl?: string;
  botType?: string;
}): Promise<{ qrcode: string; qrcodeUrl: string }> {
  const baseUrl = ensureTrailingSlash(options?.qrApiBaseUrl ?? DEFAULT_QR_BASE_URL);
  const botType = options?.botType?.trim() || "3";
  const url = new URL(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, baseUrl);
  const raw = await fetchText(url.toString(), {
    method: "GET",
    headers: buildCommonHeaders(),
    signal: createAbortSignal(DEFAULT_REQUEST_TIMEOUT_MS),
  });
  const parsed = JSON.parse(raw) as {
    qrcode?: string;
    qrcode_img_content?: string;
  };
  if (!parsed.qrcode || !parsed.qrcode_img_content) {
    throw new Error("WeChat QR login response is missing qrcode data");
  }
  return {
    qrcode: parsed.qrcode,
    qrcodeUrl: parsed.qrcode_img_content,
  };
}

export async function waitForQrLogin(options: {
  sessionKey: string;
  qrcode: string;
  qrApiBaseUrl?: string;
  timeoutMs?: number;
}): Promise<{
  connected: boolean;
  rawAccountId?: string;
  token?: string;
  baseUrl?: string;
  userId?: string;
  message: string;
}> {
  const baseUrl = ensureTrailingSlash(options.qrApiBaseUrl ?? DEFAULT_QR_BASE_URL);
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 240_000);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const url = new URL(
      `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(options.qrcode)}`,
      baseUrl,
    );

    let parsed: {
      status?: string;
      bot_token?: string;
      ilink_bot_id?: string;
      ilink_user_id?: string;
      baseurl?: string;
      redirect_host?: string;
    };

    try {
      const raw = await fetchText(url.toString(), {
        method: "GET",
        headers: buildCommonHeaders(),
        signal: createAbortSignal(DEFAULT_POLL_TIMEOUT_MS),
      });
      parsed = JSON.parse(raw);
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        continue;
      }
      throw error;
    }

    switch (parsed.status) {
      case "wait":
      case "scaned":
      case "scaned_but_redirect":
        break;
      case "confirmed":
        if (!parsed.bot_token || !parsed.ilink_bot_id) {
          return {
            connected: false,
            message: "WeChat login confirmed but token/account ID is missing",
          };
        }
        return {
          connected: true,
          rawAccountId: parsed.ilink_bot_id,
          token: parsed.bot_token,
          baseUrl: parsed.baseurl?.trim() || DEFAULT_API_BASE_URL,
          userId: parsed.ilink_user_id?.trim() || undefined,
          message: "WeChat login confirmed",
        };
      case "expired":
        return {
          connected: false,
          message: "WeChat QR code expired",
        };
      default:
        break;
    }
  }

  return {
    connected: false,
    message: `Timed out waiting for WeChat login for session ${options.sessionKey}`,
  };
}

export async function getUpdates(options: {
  baseUrl?: string;
  token: string;
  getUpdatesBuf?: string;
  timeoutMs?: number;
}): Promise<WeChatGetUpdatesResponse> {
  const baseUrl = ensureTrailingSlash(options.baseUrl ?? DEFAULT_API_BASE_URL);
  const body = JSON.stringify({
    get_updates_buf: options.getUpdatesBuf ?? "",
    base_info: {
      channel_version: "paseo-wechat-mvp",
    },
  });
  const url = new URL("ilink/bot/getupdates", baseUrl);
  try {
    const raw = await fetchText(url.toString(), {
      method: "POST",
      headers: buildAuthedHeaders(options.token, body),
      body,
      signal: createAbortSignal(options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS),
    });
    return JSON.parse(raw) as WeChatGetUpdatesResponse;
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      return {
        ret: 0,
        msgs: [],
        get_updates_buf: options.getUpdatesBuf,
      };
    }
    throw error;
  }
}

export async function sendTextMessage(options: {
  baseUrl?: string;
  token: string;
  toUserId: string;
  contextToken?: string;
  text: string;
}): Promise<void> {
  const baseUrl = ensureTrailingSlash(options.baseUrl ?? DEFAULT_API_BASE_URL);
  const body = JSON.stringify({
    msg: {
      from_user_id: "",
      to_user_id: options.toUserId,
      client_id: randomUUID(),
      message_type: 2,
      message_state: 2,
      context_token: options.contextToken,
      item_list: [
        {
          type: 1,
          text_item: {
            text: options.text,
          },
        },
      ],
    },
    base_info: {
      channel_version: "paseo-wechat-mvp",
    },
  });
  const url = new URL("ilink/bot/sendmessage", baseUrl);
  await fetchText(url.toString(), {
    method: "POST",
    headers: buildAuthedHeaders(options.token, body),
    body,
    signal: createAbortSignal(DEFAULT_REQUEST_TIMEOUT_MS),
  });
}

export function extractTextBody(message: WeChatMessage): string {
  const items = message.item_list ?? [];
  for (const item of items) {
    const text = item.text_item?.text?.trim();
    if (item.type === 1 && text) {
      return text;
    }
  }
  return "";
}
