import QRCode from "qrcode";
import type { Command } from "commander";

import { getDaemonHost } from "../../utils/client.js";
import { postDaemonJson } from "./http.js";

export interface WeChatLoginOptions {
  host?: string;
  timeout?: string;
  json?: boolean;
  botType?: string;
}

type StartLoginResponse = {
  sessionKey?: string;
  qrcodeUrl?: string;
  message?: string;
  error?: string;
};

type WaitLoginResponse = {
  connected?: boolean;
  accountId?: string;
  userId?: string;
  message?: string;
  error?: string;
};

const DEFAULT_TIMEOUT_SECONDS = 240;

function parseTimeoutMs(raw: string | undefined): number {
  if (!raw || raw.trim().length === 0) {
    return DEFAULT_TIMEOUT_SECONDS * 1000;
  }

  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`Invalid timeout value: ${raw}`);
  }
  return Math.ceil(seconds * 1000);
}


export async function runWeChatLoginCommand(options: WeChatLoginOptions, _command: Command): Promise<void> {
  const host = getDaemonHost({ host: options.host });
  const timeoutMs = parseTimeoutMs(options.timeout);

  const start = await postDaemonJson<StartLoginResponse>(host, "/api/wechat/login/start", {
    ...(options.botType?.trim() ? { botType: options.botType.trim() } : {}),
  });

  if (!start.sessionKey || !start.qrcodeUrl) {
    throw new Error(start.error ?? start.message ?? "Failed to start WeChat login");
  }

  const qr = await QRCode.toString(start.qrcodeUrl, {
    type: "terminal",
    small: true,
  });

  if (!options.json) {
    process.stdout.write("\nScan this WeChat QR code:\n");
    process.stdout.write(`${qr}\n`);
    process.stdout.write(`${start.qrcodeUrl}\n\n`);
    process.stdout.write("Waiting for WeChat scan confirmation...\n");
  }

  const waitResult = await postDaemonJson<WaitLoginResponse>(host, "/api/wechat/login/wait", {
    sessionKey: start.sessionKey,
    timeoutMs,
  });

  if (!waitResult.connected) {
    throw new Error(waitResult.error ?? waitResult.message ?? "WeChat login was not completed");
  }

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          sessionKey: start.sessionKey,
          qrcodeUrl: start.qrcodeUrl,
          connected: true,
          accountId: waitResult.accountId ?? null,
          userId: waitResult.userId ?? null,
          message: waitResult.message ?? null,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  process.stdout.write("\nWeChat login connected.\n");
  if (waitResult.accountId) {
    process.stdout.write(`Account: ${waitResult.accountId}\n`);
  }
  if (waitResult.userId) {
    process.stdout.write(`User: ${waitResult.userId}\n`);
  }
}
