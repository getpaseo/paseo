import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type pino from "pino";

import type { WeChatAccountRecord, WeChatPeerSessionRecord, WeChatState } from "./types.js";

const WeChatAccountRecordSchema = z.object({
  id: z.string(),
  rawAccountId: z.string(),
  userId: z.string().optional(),
  token: z.string(),
  baseUrl: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  enabled: z.boolean(),
  getUpdatesBuf: z.string().optional(),
  lastInboundAt: z.string().optional(),
  lastOutboundAt: z.string().optional(),
  lastError: z.string().nullable().optional(),
});

const WeChatPeerSessionRecordSchema = z.object({
  accountId: z.string(),
  peerId: z.string(),
  agentId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  contextToken: z.string().optional(),
});

const WeChatStateSchema = z.object({
  accounts: z.array(WeChatAccountRecordSchema),
  peerSessions: z.array(WeChatPeerSessionRecordSchema),
});

function defaultState(): WeChatState {
  return {
    accounts: [],
    peerSessions: [],
  };
}

export function normalizeWeChatAccountId(rawAccountId: string): string {
  const trimmed = rawAccountId.trim().toLowerCase();
  return trimmed
    .replace(/@im\.bot$/u, "-im-bot")
    .replace(/@im\.wechat$/u, "-im-wechat")
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

export class WeChatStateStore {
  private readonly filePath: string;
  private readonly logger: pino.Logger;
  private loaded = false;
  private state: WeChatState = defaultState();
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(options: { paseoHome: string; logger: pino.Logger }) {
    this.filePath = path.join(options.paseoHome, "wechat", "state.json");
    this.logger = options.logger.child({ component: "wechat-state-store" });
  }

  async initialize(): Promise<void> {
    await this.load();
  }

  async listAccounts(): Promise<WeChatAccountRecord[]> {
    await this.load();
    return [...this.state.accounts].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async getAccount(accountId: string): Promise<WeChatAccountRecord | null> {
    await this.load();
    return this.state.accounts.find((account) => account.id === accountId) ?? null;
  }

  async upsertAccount(
    input: Omit<WeChatAccountRecord, "createdAt" | "updatedAt"> & { createdAt?: string; updatedAt?: string },
  ): Promise<WeChatAccountRecord> {
    await this.load();
    const now = new Date().toISOString();
    const existing = this.state.accounts.find((account) => account.id === input.id) ?? null;
    const next: WeChatAccountRecord = {
      ...existing,
      ...input,
      createdAt: existing?.createdAt ?? input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    };

    this.state.accounts = [
      ...this.state.accounts.filter((account) => account.id !== input.id),
      next,
    ];
    await this.enqueuePersist();
    return next;
  }

  async patchAccount(
    accountId: string,
    update: Partial<Omit<WeChatAccountRecord, "id" | "createdAt">>,
  ): Promise<WeChatAccountRecord | null> {
    await this.load();
    const existing = this.state.accounts.find((account) => account.id === accountId) ?? null;
    if (!existing) {
      return null;
    }
    const next: WeChatAccountRecord = {
      ...existing,
      ...update,
      updatedAt: new Date().toISOString(),
    };
    this.state.accounts = [
      ...this.state.accounts.filter((account) => account.id !== accountId),
      next,
    ];
    await this.enqueuePersist();
    return next;
  }

  async getPeerSession(accountId: string, peerId: string): Promise<WeChatPeerSessionRecord | null> {
    await this.load();
    return (
      this.state.peerSessions.find(
        (session) => session.accountId === accountId && session.peerId === peerId,
      ) ?? null
    );
  }

  async listPeerSessions(): Promise<WeChatPeerSessionRecord[]> {
    await this.load();
    return [...this.state.peerSessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async upsertPeerSession(
    input: Omit<WeChatPeerSessionRecord, "createdAt" | "updatedAt"> & {
      createdAt?: string;
      updatedAt?: string;
    },
  ): Promise<WeChatPeerSessionRecord> {
    await this.load();
    const now = new Date().toISOString();
    const existing =
      this.state.peerSessions.find(
        (session) => session.accountId === input.accountId && session.peerId === input.peerId,
      ) ?? null;
    const next: WeChatPeerSessionRecord = {
      ...existing,
      ...input,
      createdAt: existing?.createdAt ?? input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    };
    this.state.peerSessions = [
      ...this.state.peerSessions.filter(
        (session) => !(session.accountId === input.accountId && session.peerId === input.peerId),
      ),
      next,
    ];
    await this.enqueuePersist();
    return next;
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = WeChatStateSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        this.state = parsed.data;
      } else {
        this.logger.warn({ issues: parsed.error.issues }, "Invalid WeChat state; starting fresh");
        this.state = defaultState();
      }
    } catch (error) {
      this.state = defaultState();
      this.logger.debug({ err: error }, "WeChat state file not found; starting fresh");
    }

    this.loaded = true;
  }

  private async enqueuePersist(): Promise<void> {
    this.persistQueue = this.persistQueue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, JSON.stringify(this.state, null, 2), "utf8");
    });
    await this.persistQueue;
  }
}
