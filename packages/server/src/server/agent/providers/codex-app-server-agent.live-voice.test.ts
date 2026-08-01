import { describe, expect, test } from "vitest";

import type { AgentSession, AgentSessionConfig } from "../agent-sdk-types.js";
import { asAgentRealtimeVoiceSession } from "../agent-realtime-voice.js";
import type { AgentRealtimeVoiceEvent } from "../agent-realtime-voice.js";
import { CodexAppServerAgentSession } from "./codex-app-server-agent.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";

const THREAD_ID = "thread-live-voice";

interface CodexLiveVoiceTestSession extends AgentSession {
  connected: boolean;
  currentThreadId: string | null;
  activeForegroundTurnId: string | null;
  client: { request: (method: string, params?: unknown) => Promise<unknown> } | null;
  handleNotification(method: string, params: unknown): void;
  realtimeStart(params: { sdp: string; voice?: string; realtimeSessionId: string }): Promise<void>;
  realtimeStop(): Promise<void>;
  subscribeRealtimeEvents(callback: (event: AgentRealtimeVoiceEvent) => void): () => void;
}

function createConfig(): AgentSessionConfig {
  return {
    provider: "codex",
    cwd: "/tmp/codex-live-voice-test",
    modeId: "auto",
    model: "gpt-5.4",
  };
}

function createSession(liveVoiceEnabled: boolean): {
  session: CodexLiveVoiceTestSession;
  requests: Array<{ method: string; params?: unknown }>;
} {
  const requests: Array<{ method: string; params?: unknown }> = [];
  const session = new CodexAppServerAgentSession(
    createConfig(),
    null,
    createTestLogger(),
    () => {
      throw new Error("Test session cannot spawn Codex app-server");
    },
    {},
    false,
    false,
    false,
    "agent-live-voice",
    undefined,
    liveVoiceEnabled,
  ) as unknown as CodexLiveVoiceTestSession;
  session.connected = true;
  session.currentThreadId = THREAD_ID;
  session.activeForegroundTurnId = null;
  session.client = {
    request: async (method, params) => {
      requests.push({ method, params });
      return {};
    },
  };
  return { session, requests };
}

/** Drops the thread-load bookkeeping requests `ensureThreadLoaded` issues. */
function realtimeRequests(
  requests: Array<{ method: string; params?: unknown }>,
): Array<{ method: string; params?: unknown }> {
  return requests.filter((request) => request.method.startsWith("thread/realtime/"));
}

describe("codex live voice", () => {
  test("advertises supportsLiveVoice only when the realtime flag was passed", () => {
    expect(createSession(true).session.capabilities.supportsLiveVoice).toBe(true);
    expect(createSession(false).session.capabilities.supportsLiveVoice).toBe(false);
  });

  test("implements the realtime voice seam", () => {
    expect(asAgentRealtimeVoiceSession(createSession(true).session)).not.toBeNull();
  });

  test("realtimeStart sends the v3 WebRTC start params", async () => {
    const { session, requests } = createSession(true);
    await session.realtimeStart({ sdp: "offer-sdp", realtimeSessionId: "live-1" });
    expect(realtimeRequests(requests)).toEqual([
      {
        method: "thread/realtime/start",
        params: {
          threadId: THREAD_ID,
          outputModality: "audio",
          version: "v3",
          transport: { type: "webrtc", sdp: "offer-sdp" },
          realtimeSessionId: "live-1",
        },
      },
    ]);
  });

  test("realtimeStart includes voice only when provided", async () => {
    const { session, requests } = createSession(true);
    await session.realtimeStart({ sdp: "offer-sdp", realtimeSessionId: "live-1", voice: "cedar" });
    expect(realtimeRequests(requests)[0]?.params).toMatchObject({ voice: "cedar" });
  });

  test("realtimeStart forwards the Paseo prompt, initial items, and startup-context opt-out", async () => {
    const { session, requests } = createSession(true);
    await session.realtimeStart({
      sdp: "offer-sdp",
      realtimeSessionId: "live-1",
      prompt: "you are the voice of paseo",
      initialItems: [{ role: "developer", text: "snapshot" }],
      includeStartupContext: false,
    });
    expect(realtimeRequests(requests)[0]?.params).toMatchObject({
      prompt: "you are the voice of paseo",
      initialItems: [{ role: "developer", text: "snapshot" }],
      includeStartupContext: false,
    });
  });

  test("realtimeStart omits initialItems when the list is empty", async () => {
    const { session, requests } = createSession(true);
    await session.realtimeStart({
      sdp: "offer-sdp",
      realtimeSessionId: "live-1",
      initialItems: [],
    });
    expect(realtimeRequests(requests)[0]?.params).not.toHaveProperty("initialItems");
  });

  test("realtimeStop is thread-scoped", async () => {
    const { session, requests } = createSession(true);
    await session.realtimeStop();
    expect(realtimeRequests(requests)).toEqual([
      { method: "thread/realtime/stop", params: { threadId: THREAD_ID } },
    ]);
  });

  test("routes realtime notifications to the dedicated subscription, not the timeline", () => {
    const { session } = createSession(true);
    const realtimeEvents: AgentRealtimeVoiceEvent[] = [];
    const streamEvents: unknown[] = [];
    session.subscribeRealtimeEvents((event) => realtimeEvents.push(event));
    session.subscribe((event) => streamEvents.push(event));

    session.handleNotification("thread/realtime/started", {
      threadId: THREAD_ID,
      realtimeSessionId: "live-1",
      version: "v3",
    });
    session.handleNotification("thread/realtime/sdp", { threadId: THREAD_ID, sdp: "answer-sdp" });
    session.handleNotification("thread/realtime/transcript/done", {
      threadId: THREAD_ID,
      role: "user",
      text: "hello",
    });
    session.handleNotification("thread/realtime/error", {
      threadId: THREAD_ID,
      message: "invalid_offer",
    });
    session.handleNotification("thread/realtime/closed", { threadId: THREAD_ID, reason: "done" });

    expect(realtimeEvents).toEqual([
      { kind: "started", realtimeSessionId: "live-1", version: "v3" },
      { kind: "sdp", sdp: "answer-sdp" },
      { kind: "transcript", role: "user", text: "hello" },
      { kind: "error", message: "invalid_offer" },
      { kind: "closed", reason: "done" },
    ]);
    expect(streamEvents).toEqual([]);
  });

  test("drops realtime deltas and item additions in phase 1", () => {
    const { session } = createSession(true);
    const realtimeEvents: AgentRealtimeVoiceEvent[] = [];
    session.subscribeRealtimeEvents((event) => realtimeEvents.push(event));

    session.handleNotification("thread/realtime/transcript/delta", {
      threadId: THREAD_ID,
      delta: "he",
    });
    session.handleNotification("thread/realtime/itemAdded", {
      threadId: THREAD_ID,
      item: { id: "item-1" },
    });

    expect(realtimeEvents).toEqual([]);
  });

  test("a malformed closed notification still closes the call", () => {
    const { session } = createSession(true);
    const realtimeEvents: AgentRealtimeVoiceEvent[] = [];
    session.subscribeRealtimeEvents((event) => realtimeEvents.push(event));

    session.handleNotification("thread/realtime/closed", "not-an-object");

    expect(realtimeEvents).toEqual([{ kind: "closed", reason: null }]);
  });
});
