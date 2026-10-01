import { createSign } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type pino from "pino";
import type { PushPayload } from "./push-service.js";

/** Tokens the app registered straight from Firebase, without Expo: "fcm:<registration token>". */
export const FCM_TOKEN_PREFIX = "fcm:";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const ACCESS_TOKEN_MARGIN_MS = 5 * 60 * 1000;

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/** The Firebase service-account key: $PANDAOS_FCM_SERVICE_ACCOUNT, else the first *firebase-adminsdk*.json. */
export async function findServiceAccountFile(home: string = os.homedir()): Promise<string | null> {
  const fromEnv = process.env.PANDAOS_FCM_SERVICE_ACCOUNT?.trim();
  if (fromEnv) return fromEnv;
  const dir = path.join(home, ".config", "pandaos-push");
  const entries = await readdir(dir).catch(() => []);
  const file = entries.find((name) => name.includes("firebase-adminsdk") && name.endsWith(".json"));
  return file ? path.join(dir, file) : null;
}

/**
 * The FCM data message expo-notifications turns into a notification itself: title, message and a
 * JSON body it hands to the app on tap, exactly the fields the Expo push service would send.
 */
export function buildFcmMessage(token: string, payload: PushPayload): Record<string, unknown> {
  return {
    message: {
      token,
      android: { priority: "HIGH" },
      data: {
        title: payload.title,
        message: payload.body,
        body: JSON.stringify(payload.data ?? {}),
        channelId: "default",
      },
    },
  };
}

/** Sends pushes to Android devices directly through Firebase Cloud Messaging HTTP v1. */
export class FcmSender {
  private account: ServiceAccount | null = null;
  private accessToken: { value: string; expiresAt: number } | null = null;

  public constructor(
    private readonly options: {
      logger: pino.Logger;
      onInvalidToken: (token: string) => void;
      fetchImpl?: typeof fetch;
      now?: () => number;
      readAccountFile?: () => Promise<string | null>;
    },
  ) {}

  public async send(tokens: readonly string[], payload: PushPayload): Promise<void> {
    if (tokens.length === 0) return;
    const account = await this.loadAccount();
    if (!account) {
      this.options.logger.warn(
        { tokenCount: tokens.length },
        "FCM push skipped: no service account",
      );
      return;
    }
    const accessToken = await this.getAccessToken(account);
    await Promise.all(tokens.map((token) => this.sendOne(account, accessToken, token, payload)));
  }

  private async sendOne(
    account: ServiceAccount,
    accessToken: string,
    prefixedToken: string,
    payload: PushPayload,
  ): Promise<void> {
    const token = prefixedToken.slice(FCM_TOKEN_PREFIX.length);
    const response = await this.fetch()(
      `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(buildFcmMessage(token, payload)),
      },
    );
    if (response.ok) return;
    const text = await response.text().catch(() => "");
    // FCM answers 404 UNREGISTERED (or 400 INVALID_ARGUMENT) for a token the device dropped.
    if (response.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/.test(text)) {
      this.options.onInvalidToken(prefixedToken);
    }
    this.options.logger.warn({ status: response.status }, "FCM push was rejected");
  }

  private async loadAccount(): Promise<ServiceAccount | null> {
    if (this.account) return this.account;
    const file = await (this.options.readAccountFile ?? findServiceAccountFile)();
    if (!file) return null;
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<ServiceAccount>;
    if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
      throw new Error(
        "Firebase service account is missing project_id, client_email or private_key",
      );
    }
    this.account = parsed as ServiceAccount;
    return this.account;
  }

  private async getAccessToken(account: ServiceAccount): Promise<string> {
    const now = this.options.now?.() ?? Date.now();
    if (this.accessToken && this.accessToken.expiresAt - ACCESS_TOKEN_MARGIN_MS > now) {
      return this.accessToken.value;
    }
    const issuedAt = Math.floor(now / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64url(
      JSON.stringify({
        iss: account.client_email,
        scope: SCOPE,
        aud: TOKEN_URL,
        iat: issuedAt,
        exp: issuedAt + 3600,
      }),
    );
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${claims}`);
    const assertion = `${header}.${claims}.${base64url(signer.sign(account.private_key))}`;
    const response = await this.fetch()(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    });
    if (!response.ok) throw new Error(`Google OAuth answered ${response.status} for the FCM key`);
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error("Google OAuth returned no access token");
    this.accessToken = {
      value: body.access_token,
      expiresAt: now + (body.expires_in ?? 3600) * 1000,
    };
    return this.accessToken.value;
  }

  private fetch(): typeof fetch {
    return this.options.fetchImpl ?? fetch;
  }
}
