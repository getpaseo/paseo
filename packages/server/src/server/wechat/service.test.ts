import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import pino from "pino";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  startQrLogin: vi.fn(),
  waitForQrLogin: vi.fn(),
  getUpdates: vi.fn(),
  sendTextMessage: vi.fn(),
}));

const agentMocks = vi.hoisted(() => ({
  sendPromptToAgent: vi.fn(),
}));

vi.mock("./api.js", () => ({
  startQrLogin: apiMocks.startQrLogin,
  waitForQrLogin: apiMocks.waitForQrLogin,
  getUpdates: apiMocks.getUpdates,
  sendTextMessage: apiMocks.sendTextMessage,
  extractTextBody: (message: { item_list?: Array<{ type?: number; text_item?: { text?: string } }> }) => {
    for (const item of message.item_list ?? []) {
      if (item.type === 1 && item.text_item?.text) {
        return item.text_item.text;
      }
    }
    return "";
  },
}));

vi.mock("../agent/mcp-shared.js", () => ({
  sendPromptToAgent: agentMocks.sendPromptToAgent,
}));

import { PaseoWeChatService } from "./service.js";

type JsonResponse = {
  statusCode: number;
  body: unknown;
  status: (code: number) => JsonResponse;
  json: (value: unknown) => JsonResponse;
};

function createJsonResponse(): JsonResponse {
  return {
    statusCode: 200,
    body: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(value: unknown) {
      this.body = value;
      return this;
    },
  };
}

async function waitForCondition(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for condition after ${timeoutMs}ms`);
}

describe("PaseoWeChatService", () => {
  let paseoHomeRoot: string;

  beforeEach(async () => {
    paseoHomeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-wechat-test-"));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(paseoHomeRoot, { recursive: true, force: true });
  });

  test("stores login result and relays inbound text through an agent session", async () => {
    apiMocks.startQrLogin.mockResolvedValue({
      qrcode: "qr-token",
      qrcodeUrl: "https://example.com/qr",
    });
    apiMocks.waitForQrLogin.mockResolvedValue({
      connected: true,
      rawAccountId: "bot123@im.bot",
      token: "token-123",
      baseUrl: "https://ilinkai.weixin.qq.com",
      userId: "owner@im.wechat",
      message: "ok",
    });

    let updateCallCount = 0;
    apiMocks.getUpdates.mockImplementation(async () => {
      updateCallCount += 1;
      if (updateCallCount === 1) {
        return {
          ret: 0,
          get_updates_buf: "buf-1",
          msgs: [
            {
              from_user_id: "user001@im.wechat",
              create_time_ms: 1710000000000,
              context_token: "ctx-123",
              item_list: [
                {
                  type: 1,
                  text_item: {
                    text: "hello from wechat",
                  },
                },
              ],
            },
          ],
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        ret: 0,
        get_updates_buf: "buf-1",
        msgs: [],
      };
    });

    apiMocks.sendTextMessage.mockResolvedValue(undefined);
    agentMocks.sendPromptToAgent.mockResolvedValue(undefined);

    const agentManager = {
      createAgent: vi.fn().mockResolvedValue({ id: "agent-1" }),
      waitForAgentEvent: vi.fn().mockResolvedValue({
        status: "idle",
        permission: null,
        lastMessage: null,
      }),
      fetchTimeline: vi.fn().mockReturnValue({
        rows: [
          {
            item: {
              type: "assistant_message",
              text: "agent reply",
            },
          },
        ],
      }),
    } as any;
    const agentStorage = {} as any;

    const service = new PaseoWeChatService({
      paseoHome: path.join(paseoHomeRoot, ".paseo"),
      config: {
        enabled: true,
        autoStart: true,
        provider: "codex",
        cwd: process.cwd(),
        pollTimeoutMs: 20,
      },
      agentManager,
      agentStorage,
      logger: pino({ level: "silent" }),
    });
    await service.initialize();

    const startRes = createJsonResponse();
    await service.startLoginHandler()(
      { body: { sessionKey: "session-1" } } as any,
      startRes as any,
      (() => undefined) as any,
    );
    expect(startRes.statusCode).toBe(200);
    expect(startRes.body).toMatchObject({
      sessionKey: "session-1",
      qrcodeUrl: "https://example.com/qr",
    });

    const waitRes = createJsonResponse();
    await service.waitLoginHandler()(
      { body: { sessionKey: "session-1", timeoutMs: 1000 } } as any,
      waitRes as any,
      (() => undefined) as any,
    );
    expect(waitRes.statusCode).toBe(200);
    expect(waitRes.body).toMatchObject({
      connected: true,
      accountId: "bot123-im-bot",
      userId: "owner@im.wechat",
    });

    await waitForCondition(() => apiMocks.sendTextMessage.mock.calls.length > 0);

    expect(agentManager.createAgent).toHaveBeenCalledTimes(1);
    expect(agentMocks.sendPromptToAgent).toHaveBeenCalledTimes(1);
    expect(apiMocks.sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "token-123",
        toUserId: "user001@im.wechat",
        contextToken: "ctx-123",
        text: "agent reply",
      }),
    );

    const listRes = createJsonResponse();
    await service.listAccountsHandler()(
      {} as any,
      listRes as any,
      (() => undefined) as any,
    );
    expect(listRes.statusCode).toBe(200);
    expect(listRes.body).toMatchObject({
      accounts: [
        expect.objectContaining({
          id: "bot123-im-bot",
          running: true,
          userId: "owner@im.wechat",
        }),
      ],
    });

    await service.stop();
  });
});
