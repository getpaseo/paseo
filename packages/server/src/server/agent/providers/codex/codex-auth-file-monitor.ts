import { createHash } from "node:crypto";
import { watchFile, unwatchFile, type StatsListener } from "node:fs";
import { readFile } from "node:fs/promises";

export interface CodexAuthIdentity {
  key: string;
  label: string;
}

export interface CodexAuthFileMonitorOptions {
  filePath: string;
  initialIdentity: CodexAuthIdentity;
  onIdentityChange: (identity: CodexAuthIdentity) => void;
  intervalMs?: number;
  settleDelaysMs?: number[];
}

const SIGNED_OUT_IDENTITY: CodexAuthIdentity = {
  key: "signed-out",
  label: "Not signed in",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readRecord(
  value: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  const child = value?.[key];
  return isRecord(child) ? child : null;
}

function readString(value: Record<string, unknown> | null, ...keys: string[]): string | null {
  for (const key of keys) {
    const candidate = value?.[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function parseJwtPayload(token: string | null): Record<string, unknown> | null {
  if (!token) return null;
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fallbackAccountLabel(accountId: string): string {
  const suffix = accountId.slice(-6);
  return suffix ? `Codex account · ${suffix}` : "Codex account";
}

export function parseCodexAuthIdentity(contents: string): CodexAuthIdentity | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const tokens = readRecord(parsed, "tokens");
  const idToken = readString(tokens, "id_token", "idToken");
  const claims = parseJwtPayload(idToken);
  const authClaims = readRecord(claims, "https://api.openai.com/auth");
  const profileClaims = readRecord(claims, "https://api.openai.com/profile");
  const agentIdentity = readRecord(parsed, "agent_identity");
  const accountId =
    readString(tokens, "account_id", "accountId") ??
    readString(authClaims, "chatgpt_account_id", "workspace_account_id") ??
    readString(claims, "chatgpt_account_id") ??
    readString(agentIdentity, "account_id", "accountId");
  const email =
    readString(claims, "email") ??
    readString(profileClaims, "email") ??
    readString(agentIdentity, "email");

  if (accountId) {
    return {
      key: `account:${accountId}`,
      label: email ?? fallbackAccountLabel(accountId),
    };
  }
  if (email) {
    return { key: `email:${email.toLowerCase()}`, label: email };
  }

  const opaqueCredential = readString(parsed, "OPENAI_API_KEY", "personal_access_token") ?? idToken;
  if (opaqueCredential) {
    const authMode = readString(parsed, "auth_mode");
    return {
      key: `credential:${fingerprint(opaqueCredential)}`,
      label: authMode === "chatgpt" ? "Codex account" : "API credential",
    };
  }

  return null;
}

export async function readCodexAuthIdentity(filePath: string): Promise<CodexAuthIdentity | null> {
  try {
    return parseCodexAuthIdentity(await readFile(filePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return SIGNED_OUT_IDENTITY;
    }
    return null;
  }
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

export class CodexAuthFileMonitor {
  private readonly listener: StatsListener;
  private readonly settleDelaysMs: number[];
  private observedIdentity: CodexAuthIdentity;
  private reconcileGeneration = 0;
  private started = false;

  constructor(private readonly options: CodexAuthFileMonitorOptions) {
    this.observedIdentity = options.initialIdentity;
    this.settleDelaysMs = options.settleDelaysMs ?? [120, 300, 700];
    this.listener = () => {
      void this.reconcile();
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    watchFile(
      this.options.filePath,
      { interval: this.options.intervalMs ?? 1_000, persistent: false },
      this.listener,
    );
    void this.reconcile();
  }

  close(): void {
    if (!this.started) return;
    this.started = false;
    this.reconcileGeneration += 1;
    unwatchFile(this.options.filePath, this.listener);
  }

  private async reconcile(): Promise<void> {
    const generation = ++this.reconcileGeneration;
    let identity: CodexAuthIdentity | null = null;
    for (const delayMs of this.settleDelaysMs) {
      await wait(delayMs);
      if (!this.started || generation !== this.reconcileGeneration) return;
      identity = await readCodexAuthIdentity(this.options.filePath);
      if (identity) break;
    }
    if (!identity || !this.started || generation !== this.reconcileGeneration) return;
    if (identity.key === this.observedIdentity.key) {
      this.observedIdentity = identity;
      return;
    }
    this.observedIdentity = identity;
    this.options.onIdentityChange(identity);
  }
}
