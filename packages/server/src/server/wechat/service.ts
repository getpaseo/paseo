import { randomUUID } from "node:crypto";
import type pino from "pino";
import type { RequestHandler } from "express";

import type { AgentSessionConfig } from "../agent/agent-sdk-types.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { sendPromptToAgent } from "../agent/mcp-shared.js";
import type { PaseoWeChatConfig, WeChatAccountRecord, WeChatMessage } from "./types.js";
import { WeChatStateStore, normalizeWeChatAccountId } from "./store.js";
import { extractTextBody, getUpdates, sendTextMessage, startQrLogin, waitForQrLogin } from "./api.js";

const DEFAULT_SYSTEM_PROMPT = [
  "You are a WeChat-connected assistant running inside Paseo.",
  "Reply in plain text only.",
  "Keep replies concise, helpful, and directly addressed to the WeChat user.",
  "Do not mention internal agent IDs, JSON, or tooling unless the user explicitly asks.",
].join(" ");

type ActiveLoginSession = {
  sessionKey: string;
  qrcode: string;
  qrcodeUrl: string;
  createdAt: number;
};

export class PaseoWeChatService {
  private readonly logger: pino.Logger;
  private readonly store: WeChatStateStore;
  private readonly config: PaseoWeChatConfig;
  private readonly agentManager: AgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly activeLogins = new Map<string, ActiveLoginSession>();
  private readonly monitorAbortControllers = new Map<string, AbortController>();
  private readonly inboundQueues = new Map<string, Promise<void>>();

  constructor(options: {
    paseoHome: string;
    config: PaseoWeChatConfig;
    agentManager: AgentManager;
    agentStorage: AgentStorage;
    logger: pino.Logger;
  }) {
    this.logger = options.logger.child({ component: "wechat-service" });
    this.store = new WeChatStateStore({ paseoHome: options.paseoHome, logger: options.logger });
    this.config = options.config;
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
  }

  async start(): Promise<void> {
    if (!this.config.enabled || !this.config.autoStart) {
      return;
    }
    const accounts = await this.store.listAccounts();
    await Promise.all(accounts.filter((account) => account.enabled).map((account) => this.startAccountMonitor(account)));
  }

  async stop(): Promise<void> {
    for (const controller of this.monitorAbortControllers.values()) {
      controller.abort();
    }
    this.monitorAbortControllers.clear();
    this.activeLogins.clear();
  }

  listAccountsHandler(): RequestHandler {
    return async (_req, res) => {
      const accounts = await this.store.listAccounts();
      res.json({
        accounts: accounts.map((account) => ({
          ...account,
          running: this.monitorAbortControllers.has(account.id),
          token: undefined,
        })),
      });
    };
  }

  listSessionsHandler(): RequestHandler {
    return async (_req, res) => {
      const [accounts, peerSessions] = await Promise.all([
        this.store.listAccounts(),
        this.store.listPeerSessions(),
      ]);
      const accountById = new Map(accounts.map((account) => [account.id, account]));

      const sessions = await Promise.all(
        peerSessions.map(async (session) => {
          const account = accountById.get(session.accountId) ?? null;
          const liveAgent = this.agentManager.getAgent(session.agentId);
          const storedAgent = liveAgent ? null : await this.agentStorage.get(session.agentId);

          return {
            accountId: session.accountId,
            accountUserId: account?.userId ?? null,
            peerId: session.peerId,
            agentId: session.agentId,
            agentTitle: liveAgent?.config.title ?? storedAgent?.title ?? null,
            agentStatus: liveAgent?.lifecycle ?? storedAgent?.lastStatus ?? null,
            contextTokenPresent:
              typeof session.contextToken === "string" && session.contextToken.trim().length > 0,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
          };
        }),
      );

      res.json({ sessions });
    };
  }

  startLoginHandler(): RequestHandler {
    return async (req, res) => {
      try {
        const requestedSessionKey =
          typeof req.body?.sessionKey === "string" && req.body.sessionKey.trim().length > 0
            ? req.body.sessionKey.trim()
            : randomUUID();
        const result = await startQrLogin({
          qrApiBaseUrl: this.config.qrApiBaseUrl,
          botType:
            typeof req.body?.botType === "string" && req.body.botType.trim().length > 0
              ? req.body.botType.trim()
              : undefined,
        });
        this.activeLogins.set(requestedSessionKey, {
          sessionKey: requestedSessionKey,
          qrcode: result.qrcode,
          qrcodeUrl: result.qrcodeUrl,
          createdAt: Date.now(),
        });
        res.json({
          sessionKey: requestedSessionKey,
          qrcodeUrl: result.qrcodeUrl,
          message: "WeChat QR code ready",
        });
      } catch (error) {
        this.logger.error({ err: error }, "Failed to start WeChat QR login");
        res.status(500).json({ error: error instanceof Error ? error.message : "Failed to start WeChat login" });
      }
    };
  }

  waitLoginHandler(): RequestHandler {
    return async (req, res) => {
      const sessionKey =
        typeof req.body?.sessionKey === "string" && req.body.sessionKey.trim().length > 0
          ? req.body.sessionKey.trim()
          : null;
      if (!sessionKey) {
        res.status(400).json({ error: "sessionKey is required" });
        return;
      }
      const login = this.activeLogins.get(sessionKey);
      if (!login) {
        res.status(404).json({ error: `Unknown WeChat login session: ${sessionKey}` });
        return;
      }

      try {
        const result = await waitForQrLogin({
          sessionKey,
          qrcode: login.qrcode,
          qrApiBaseUrl: this.config.qrApiBaseUrl,
          timeoutMs:
            typeof req.body?.timeoutMs === "number" && Number.isFinite(req.body.timeoutMs)
              ? req.body.timeoutMs
              : undefined,
        });

        if (!result.connected || !result.rawAccountId || !result.token) {
          res.json(result);
          return;
        }

        const normalizedId = normalizeWeChatAccountId(result.rawAccountId);
        const account = await this.store.upsertAccount({
          id: normalizedId,
          rawAccountId: result.rawAccountId,
          userId: result.userId,
          token: result.token,
          baseUrl: result.baseUrl ?? this.config.apiBaseUrl ?? "https://ilinkai.weixin.qq.com",
          enabled: true,
          lastError: null,
        });

        this.activeLogins.delete(sessionKey);

        if (this.config.enabled && this.config.autoStart) {
          await this.startAccountMonitor(account);
        }

        res.json({
          connected: true,
          accountId: account.id,
          userId: account.userId,
          message: result.message,
        });
      } catch (error) {
        this.logger.error({ err: error, sessionKey }, "Failed to wait for WeChat QR login");
        res.status(500).json({ error: error instanceof Error ? error.message : "Failed to complete WeChat login" });
      }
    };
  }

  private async startAccountMonitor(account: WeChatAccountRecord): Promise<void> {
    if (this.monitorAbortControllers.has(account.id)) {
      return;
    }

    const controller = new AbortController();
    this.monitorAbortControllers.set(account.id, controller);

    void this.runMonitor(account.id, controller.signal).finally(() => {
      this.monitorAbortControllers.delete(account.id);
    });
  }

  private async runMonitor(accountId: string, signal: AbortSignal): Promise<void> {
    let currentTimeoutMs = this.config.pollTimeoutMs ?? 35_000;

    while (!signal.aborted) {
      const account = await this.store.getAccount(accountId);
      if (!account || !account.enabled) {
        return;
      }

      try {
        const response = await getUpdates({
          baseUrl: account.baseUrl,
          token: account.token,
          getUpdatesBuf: account.getUpdatesBuf,
          timeoutMs: currentTimeoutMs,
        });

        if (response.longpolling_timeout_ms && response.longpolling_timeout_ms > 0) {
          currentTimeoutMs = response.longpolling_timeout_ms;
        }

        if (response.get_updates_buf && response.get_updates_buf !== account.getUpdatesBuf) {
          await this.store.patchAccount(account.id, {
            getUpdatesBuf: response.get_updates_buf,
            lastError: null,
          });
        }

        if ((response.ret ?? 0) !== 0 || (response.errcode ?? 0) !== 0) {
          await this.store.patchAccount(account.id, {
            lastError: response.errmsg ?? `ret=${response.ret ?? 0} errcode=${response.errcode ?? 0}`,
          });
          await this.sleep(2_000, signal);
          continue;
        }

        for (const message of response.msgs ?? []) {
          await this.queueInboundMessage(account.id, message);
        }
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        this.logger.error({ err: error, accountId }, "WeChat long poll failed");
        await this.store.patchAccount(accountId, {
          lastError: error instanceof Error ? error.message : String(error),
        });
        await this.sleep(2_000, signal);
      }
    }
  }

  private async queueInboundMessage(accountId: string, message: WeChatMessage): Promise<void> {
    const peerId = message.from_user_id?.trim();
    if (!peerId) {
      return;
    }

    const queueKey = `${accountId}:${peerId}`;
    const previous = this.inboundQueues.get(queueKey) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        await this.handleInboundMessage(accountId, message);
      })
      .finally(() => {
        if (this.inboundQueues.get(queueKey) === next) {
          this.inboundQueues.delete(queueKey);
        }
      });
    this.inboundQueues.set(queueKey, next);
    await next;
  }

  private async handleInboundMessage(accountId: string, message: WeChatMessage): Promise<void> {
    const account = await this.store.getAccount(accountId);
    if (!account) {
      return;
    }

    const peerId = message.from_user_id?.trim();
    if (!peerId) {
      return;
    }

    const text = extractTextBody(message);
    if (!text) {
      this.logger.info({ accountId, peerId }, "Skipping non-text WeChat message in MVP bridge");
      return;
    }

    const contextToken = message.context_token?.trim() || undefined;
    const session = await this.ensurePeerSession(accountId, peerId);
    if (contextToken) {
      await this.store.upsertPeerSession({
        accountId,
        peerId,
        agentId: session.agentId,
        contextToken,
      });
    }

    const prompt = this.buildInboundPrompt({
      accountId,
      peerId,
      text,
      createTimeMs: message.create_time_ms,
    });

    await sendPromptToAgent({
      agentManager: this.agentManager,
      agentStorage: this.agentStorage,
      agentId: session.agentId,
      userMessageText: text,
      prompt,
      logger: this.logger,
    });

    const result = await this.agentManager.waitForAgentEvent(session.agentId, {
      waitForActive: true,
    });
    const reply = await this.resolveAgentReplyText(session.agentId, result.lastMessage);
    if (!reply) {
      return;
    }

    await sendTextMessage({
      baseUrl: account.baseUrl,
      token: account.token,
      toUserId: peerId,
      contextToken,
      text: reply,
    });

    await this.store.patchAccount(accountId, {
      lastInboundAt: new Date().toISOString(),
      lastOutboundAt: new Date().toISOString(),
      lastError: null,
    });
  }

  private async resolveAgentReplyText(
    agentId: string,
    lastMessage: string | null,
  ): Promise<string | null> {
    const direct = lastMessage?.trim();
    if (direct) {
      return direct;
    }

    try {
      const timeline = this.agentManager.fetchTimeline(agentId, {
        direction: "tail",
        limit: 200,
      });
      for (let index = timeline.rows.length - 1; index >= 0; index -= 1) {
        const row = timeline.rows[index];
        if (!row || row.item.type !== "assistant_message") {
          continue;
        }
        const text = row.item.text.trim();
        if (text.length > 0) {
          return text;
        }
      }
    } catch (error) {
      this.logger.warn({ err: error, agentId }, "Failed to resolve agent reply from timeline");
    }

    return null;
  }

  private async ensurePeerSession(accountId: string, peerId: string): Promise<{ agentId: string }> {
    const existing = await this.store.getPeerSession(accountId, peerId);
    if (existing) {
      return { agentId: existing.agentId };
    }

    const snapshot = await this.agentManager.createAgent(this.buildAgentConfig(peerId), undefined, {
      labels: {
        channel: "wechat",
        accountId,
        peerId,
      },
    });

    await this.store.upsertPeerSession({
      accountId,
      peerId,
      agentId: snapshot.id,
    });

    return { agentId: snapshot.id };
  }

  private buildAgentConfig(peerId: string): AgentSessionConfig {
    return {
      provider: this.config.provider,
      cwd: this.config.cwd,
      title: `WeChat ${peerId}`,
      systemPrompt: this.config.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT,
      modeId: this.config.modeId,
      model: this.config.model ?? undefined,
      approvalPolicy: this.config.approvalPolicy,
      sandboxMode: this.config.sandboxMode,
      networkAccess: this.config.networkAccess,
      webSearch: this.config.webSearch,
    };
  }

  private buildInboundPrompt(input: {
    accountId: string;
    peerId: string;
    text: string;
    createTimeMs?: number;
  }): string {
    const timestamp =
      typeof input.createTimeMs === "number"
        ? new Date(input.createTimeMs).toISOString()
        : new Date().toISOString();
    return [
      "[WeChat inbound]",
      `Account: ${input.accountId}`,
      `Peer: ${input.peerId}`,
      `Timestamp: ${timestamp}`,
      "",
      input.text,
    ].join("\n");
  }

  private async sleep(ms: number, signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timeout);
        reject(new Error("aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }).catch(() => undefined);
  }
}
