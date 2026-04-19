import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChatApiClient, ChatApiError } from "../src/services/chat-api.js";

interface FetchCall {
  url: string;
  init: RequestInit;
}

function mockFetch(response: {
  status?: number;
  body?: unknown;
}) {
  const calls: FetchCall[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    calls.push({ url, init: init ?? {} });
    const status = response.status ?? 200;
    return new Response(response.body === undefined ? null : JSON.stringify(response.body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchFn, calls };
}

const API_BASE = "http://test-auth:3002";
const SECRET = "dev-secret";

describe("ChatApiClient", () => {
  let calls: FetchCall[];
  let fetchFn: typeof fetch;
  let client: ChatApiClient;

  function setup(response: Parameters<typeof mockFetch>[0]) {
    ({ fetchFn, calls } = mockFetch(response));
    client = new ChatApiClient({ baseUrl: API_BASE, secret: SECRET, fetchFn });
  }

  describe("validateSession", () => {
    it("sends Bearer token, not internal secret", async () => {
      setup({
        body: {
          user: {
            id: "user_1",
            name: "Alice",
            email: "a@x",
            image: null,
            role: "user",
          },
        },
      });
      const u = await client.validateSession("tok");
      expect(u).toEqual({
        id: "user_1",
        name: "Alice",
        email: "a@x",
        image: null,
        role: "user",
      });
      expect(calls).toHaveLength(1);
      const headers = new Headers(calls[0]!.init.headers);
      expect(headers.get("authorization")).toBe("Bearer tok");
      expect(headers.get("x-internal-secret")).toBeNull();
      expect(calls[0]!.url).toBe(`${API_BASE}/api/auth/get-session`);
    });

    it("throws ChatApiError on non-200", async () => {
      setup({ status: 401, body: { error: "Invalid", code: "unauthorized" } });
      await expect(client.validateSession("bad")).rejects.toMatchObject({
        status: 401,
        code: "unauthorized",
      });
    });
  });

  describe("isOrgMember", () => {
    it("returns true on 200, false on 404, rethrows on 500", async () => {
      setup({ body: { member: true } });
      expect(await client.isOrgMember("u1", "org1")).toBe(true);
      const headers = new Headers(calls[0]!.init.headers);
      expect(headers.get("x-internal-secret")).toBe(SECRET);

      setup({ status: 404, body: { member: false } });
      expect(await client.isOrgMember("u1", "org2")).toBe(false);

      setup({ status: 500, body: { error: "boom" } });
      await expect(client.isOrgMember("u1", "org3")).rejects.toBeInstanceOf(ChatApiError);
    });
  });

  describe("sendMessage", () => {
    it("POSTs with internal secret + JSON body", async () => {
      setup({
        status: 201,
        body: {
          message: {
            id: "msg_1",
            channelId: "c1",
            userId: "u1",
            parentId: null,
            content: "hi",
            createdAt: "2026-04-18T00:00:00Z",
            editedAt: null,
            deletedAt: null,
            attachments: [],
          },
        },
      });
      const msg = await client.sendMessage({
        userId: "u1",
        channelId: "c1",
        content: "hi",
      });
      expect(msg.id).toBe("msg_1");
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(`${API_BASE}/api/internal/chat/channels/c1/messages`);
      const headers = new Headers(calls[0]!.init.headers);
      expect(headers.get("x-internal-secret")).toBe(SECRET);
      expect(headers.get("content-type")).toBe("application/json");
      expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
        userId: "u1",
        channelId: undefined,
        content: "hi",
        parentId: null,
        attachments: [],
      });
    });

    it("surfaces forbidden as ChatApiError with code forbidden", async () => {
      setup({ status: 403, body: { error: "Cannot write", code: "forbidden" } });
      await expect(
        client.sendMessage({ userId: "u1", channelId: "c1", content: "x" }),
      ).rejects.toMatchObject({ status: 403, code: "forbidden" });
    });
  });

  describe("reactions", () => {
    it("add POSTs internal endpoint with emoji in body", async () => {
      setup({ status: 201, body: { ok: true } });
      await client.addReaction({ userId: "u1", messageId: "m1", emoji: "👍" });
      expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
        userId: "u1",
        emoji: "👍",
      });
    });
    it("remove uses querystring DELETE", async () => {
      setup({ body: { ok: true } });
      await client.removeReaction({ userId: "u1", messageId: "m1", emoji: "👍" });
      expect(calls[0]!.url).toBe(
        `${API_BASE}/api/internal/chat/messages/m1/reactions?userId=u1&emoji=%F0%9F%91%8D`,
      );
      expect(calls[0]!.init.method).toBe("DELETE");
    });
  });

  describe("getUserChannels", () => {
    it("hits the internal endpoint and returns the list", async () => {
      setup({
        body: {
          channels: [
            { id: "c1", orgId: "o1", kind: "public" },
            { id: "c2", orgId: "o2", kind: "private" },
          ],
        },
      });
      const channels = await client.getUserChannels("u1");
      expect(channels.map((c) => c.id)).toEqual(["c1", "c2"]);
      const headers = new Headers(calls[0]!.init.headers);
      expect(headers.get("x-internal-secret")).toBe(SECRET);
    });
  });

  describe("editMessage", () => {
    it("PATCHes the message with userId + content", async () => {
      setup({
        body: {
          message: {
            id: "m1",
            channelId: "c1",
            userId: "u1",
            parentId: null,
            content: "new",
            createdAt: "x",
            editedAt: "y",
            deletedAt: null,
            attachments: [],
          },
        },
      });
      const m = await client.editMessage({
        userId: "u1",
        messageId: "m1",
        content: "new",
      });
      expect(m.content).toBe("new");
      expect(calls[0]!.init.method).toBe("PATCH");
      expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
        userId: "u1",
        content: "new",
      });
    });
  });

  describe("deleteMessage", () => {
    it("DELETEs with userId querystring", async () => {
      setup({ body: { ok: true } });
      await client.deleteMessage({ userId: "u1", messageId: "m1" });
      expect(calls[0]!.url).toBe(`${API_BASE}/api/internal/chat/messages/m1?userId=u1`);
      expect(calls[0]!.init.method).toBe("DELETE");
    });
  });
});

describe("OrgChatRoom registration", () => {
  it("module exports without bundle-time side effects", async () => {
    const mod = await import("../src/rooms/org-chat-room.js");
    expect(mod.OrgChatRoom).toBeDefined();
    expect(mod.OrgChatState).toBeDefined();
    expect(mod.OrgChatPresence).toBeDefined();
  });
});
