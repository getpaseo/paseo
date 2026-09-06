/**
 * Feasibility smoke for a headless "Assistant" realtime session on Codex.
 *
 * Drives a private `codex app-server` child (never the daemon on 6767, never an
 * existing session) through realtime v3 and reports what the provider does:
 *
 *   0. probe the websocket transport (no SDP, no browser). Under ChatGPT
 *      subscription auth Codex rejects it with "realtime conversation requires
 *      API key auth"; the exact message is recorded and the run continues over
 *      WebRTC with a headless Chrome as the media peer (same shape as
 *      live-voice-smoke.ts). If the websocket probe succeeds it is used instead.
 *   1. start a realtime session on a fresh thread, appendText a user message,
 *      and collect the finalized assistant transcript (plus two quick queued
 *      messages to see whether the speaking model handles them itself);
 *   2. stop, start again on the same thread with `initialItems` seeding a
 *      distinctive fact, and ask the model to recall it;
 *   3. kill the app-server, spawn a fresh one, `thread/resume`, read the
 *      persisted realtime timeline, rebuild `initialItems` from it, and ask the
 *      model to recall something from the first session.
 *
 * Output modality is audio because Codex rejects text output outside v2; audio
 * deltas are counted and discarded, and the Chrome peer's mic track is muted so
 * only appended text reaches the model. Transcripts come from
 * `thread/realtime/transcript/done` and `thread/realtime/item/completed`.
 *
 * Requires `codex` on PATH with the user's existing login and a Chrome binary
 * (default /run/current-system/sw/bin/google-chrome, override with
 * LIVE_VOICE_SMOKE_CHROME). `OPENAI_API_KEY` is stripped from the child env so
 * the run can only use that login.
 *
 * Run from packages/server: `npx tsx scripts/assistant-realtime-smoke.ts`
 * Env: ASSISTANT_SMOKE_BACKING_MODEL (default gpt-6-astra),
 *      ASSISTANT_SMOKE_REALTIME_MODEL (default gpt-live-1-codex),
 *      ASSISTANT_SMOKE_SKIP_RESTART=1 to stop after phase 2.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import playwrightModule from "playwright-core";
import { CodexAppServerClient } from "../src/server/agent/providers/codex/app-server-transport.js";
import { CODEX_LIVE_VOICE_PROVIDER_OPTIONS } from "../src/server/agent/providers/codex-live-voice-host-profile.js";

const chromium = (
  "default" in playwrightModule
    ? (playwrightModule as unknown as { default: typeof playwrightModule }).default
    : playwrightModule
).chromium;

const CHROME_PATH =
  process.env.LIVE_VOICE_SMOKE_CHROME ?? "/run/current-system/sw/bin/google-chrome";
const BACKING_MODEL = process.env.ASSISTANT_SMOKE_BACKING_MODEL ?? "gpt-6-astra";
const REALTIME_MODEL = process.env.ASSISTANT_SMOKE_REALTIME_MODEL ?? "gpt-live-1-codex";
const SKIP_RESTART = process.env.ASSISTANT_SMOKE_SKIP_RESTART === "1";

const INIT_TIMEOUT_MS = 180_000;
const START_TIMEOUT_MS = 60_000;
const REPLY_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 20_000;

const SEEDED_FACT_ITEMS = [
  {
    role: "developer" as const,
    text: "Context for this session: the user's houseplant is named Bartholomew Fern.",
  },
];

const PROMPT =
  "You are a voice assistant inside an automated test harness. Reply out loud to every " +
  "user message with one short sentence. Answer from the conversation yourself; do not " +
  "delegate, do not call tools, do not ask follow-up questions.";

type Transport = { type: "websocket" } | { type: "webrtc"; sdp: string };

interface RecordedEvent {
  at: number;
  method: string;
  params: unknown;
}

class Recorder {
  readonly events: RecordedEvent[] = [];
  audioChunks = 0;
  audioBase64Chars = 0;
  transportClosed: string | null = null;
  private readonly started = Date.now();

  record(method: string, params: unknown): void {
    if (method === "thread/realtime/outputAudio/delta") {
      const audio = (params as { audio?: { data?: string } } | undefined)?.audio;
      this.audioChunks += 1;
      this.audioBase64Chars += audio?.data?.length ?? 0;
      return;
    }
    this.events.push({ at: Date.now() - this.started, method, params });
    if (method.startsWith("thread/realtime/")) {
      process.stdout.write(`[rt +${this.events.at(-1)?.at}ms] ${describe(method, params)}\n`);
    }
  }

  find(method: string, since: number): RecordedEvent | undefined {
    return this.events.find((event) => event.at >= since && event.method === method);
  }

  transcriptsDone(role: "user" | "assistant", since = 0): { at: number; text: string }[] {
    return this.events
      .filter(
        (event) =>
          event.at >= since &&
          event.method === "thread/realtime/transcript/done" &&
          (event.params as { role?: string }).role === role,
      )
      .map((event) => ({ at: event.at, text: (event.params as { text: string }).text }));
  }

  completedItems(since = 0): { at: number; item: Record<string, unknown> }[] {
    return this.events
      .filter((event) => event.at >= since && event.method === "thread/realtime/item/completed")
      .map((event) => ({
        at: event.at,
        item: (event.params as { item: Record<string, unknown> }).item,
      }));
  }

  now(): number {
    return Date.now() - this.started;
  }
}

function describe(method: string, params: unknown): string {
  const p = (params ?? {}) as Record<string, unknown>;
  switch (method) {
    case "thread/realtime/started":
      return `started session=${String(p.realtimeSessionId)} version=${String(p.version)}`;
    case "thread/realtime/sdp":
      return `sdp answer ${String(p.sdp).length} chars`;
    case "thread/realtime/transcript/delta":
      return `transcript/delta role=${String(p.role)} ${JSON.stringify(String(p.delta).slice(0, 40))}`;
    case "thread/realtime/transcript/done":
      return `transcript/done role=${String(p.role)} ${JSON.stringify(String(p.text).slice(0, 160))}`;
    case "thread/realtime/item/started":
    case "thread/realtime/item/completed": {
      const item = (p.item ?? {}) as Record<string, unknown>;
      return `${method.slice("thread/realtime/".length)} id=${String(item.id)} session=${String(item.realtimeSessionId)} type=${String(item.type)}${
        typeof item.text === "string"
          ? ` role=${String(item.role)} ${JSON.stringify(item.text.slice(0, 120))}`
          : ""
      }${typeof item.outcome === "string" ? ` outcome=${item.outcome}` : ""}`;
    }
    case "thread/realtime/item/transcript/delta":
      return `item/transcript/delta item=${String(p.itemId)} ${JSON.stringify(String(p.delta).slice(0, 40))}`;
    case "thread/realtime/itemAdded": {
      const item = (p.item ?? {}) as Record<string, unknown>;
      return `itemAdded type=${String(item.type)} keys=${Object.keys(item).join(",")}`;
    }
    case "thread/realtime/error":
      return `error ${String(p.message)}`;
    case "thread/realtime/closed":
      return `closed reason=${String(p.reason)}`;
    default:
      return `${method} ${JSON.stringify(p).slice(0, 200)}`;
  }
}

function step(name: string): (detail?: string) => void {
  process.stdout.write(`[smoke] ${name}...\n`);
  return (detail?: string) =>
    process.stdout.write(`[smoke] ${name}: ok${detail ? ` (${detail})` : ""}\n`);
}

async function waitFor<T>(
  label: string,
  timeoutMs: number,
  probe: () => T | undefined,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

async function withTimeout<T>(label: string, timeoutMs: number, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${timeoutMs}ms in ${label}`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Headless Chrome as the WebRTC media peer. One page, one RTCPeerConnection per
 * realtime session, mic track muted so the model only hears appended text.
 */
class WebrtcPeer {
  private browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  private page: Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>["newPage"]>> | null =
    null;
  private pageServer: http.Server | null = null;

  async open(): Promise<void> {
    this.browser = await chromium.launch({
      executablePath: CHROME_PATH,
      ignoreDefaultArgs: ["--mute-audio"],
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    });
    this.page = await this.browser.newPage();
    // getUserMedia needs a potentially-trustworthy origin; 127.0.0.1 is one.
    this.pageServer = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>assistant realtime smoke</title>");
    });
    await new Promise<void>((resolve) => this.pageServer?.listen(0, "127.0.0.1", resolve));
    const address = this.pageServer.address();
    if (address === null || typeof address !== "object") {
      throw new Error("page server did not bind");
    }
    await this.page.goto(`http://127.0.0.1:${address.port}/`);
    // tsx injects `__name(...)` into functions passed to page.evaluate.
    await this.page.evaluate("window.__name = (target) => target");
  }

  async createOffer(key: string): Promise<string> {
    if (!this.page) throw new Error("peer not open");
    return await withTimeout(
      "offer",
      20_000,
      this.page.evaluate(async (pcKey: string) => {
        const w = window as unknown as Record<string, unknown>;
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const pc = new RTCPeerConnection();
        w[pcKey] = pc;
        for (const track of stream.getTracks()) {
          track.enabled = false;
          pc.addTrack(track, stream);
        }
        pc.createDataChannel("oai-events");
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("ice timeout")), 10_000);
          const check = () => {
            if (pc.iceGatheringState === "complete") {
              clearTimeout(timer);
              resolve();
            }
          };
          pc.addEventListener("icegatheringstatechange", check);
          check();
        });
        return pc.localDescription?.sdp ?? "";
      }, key),
    );
  }

  async applyAnswer(key: string, answerSdp: string): Promise<string> {
    if (!this.page) throw new Error("peer not open");
    return await withTimeout(
      "webrtc connected",
      30_000,
      this.page.evaluate(
        async ({ pcKey, sdp }: { pcKey: string; sdp: string }) => {
          const w = window as unknown as Record<string, unknown>;
          const pc = w[pcKey] as RTCPeerConnection;
          await pc.setRemoteDescription({ type: "answer", sdp });
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error(`stuck in ${pc.connectionState}`)),
              25_000,
            );
            const check = () => {
              if (pc.connectionState === "connected") {
                clearTimeout(timer);
                resolve();
              } else if (pc.connectionState === "failed") {
                clearTimeout(timer);
                reject(new Error("connection failed"));
              }
            };
            pc.addEventListener("connectionstatechange", check);
            check();
          });
          return pc.connectionState;
        },
        { pcKey: key, sdp: answerSdp },
      ),
    );
  }

  async closeConnection(key: string): Promise<void> {
    if (!this.page) return;
    await this.page
      .evaluate((pcKey: string) => {
        const w = window as unknown as Record<string, unknown>;
        (w[pcKey] as RTCPeerConnection | undefined)?.close();
        delete w[pcKey];
      }, key)
      .catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    this.pageServer?.close();
  }
}

interface AppServer {
  child: ChildProcessWithoutNullStreams;
  client: CodexAppServerClient;
  recorder: Recorder;
  stderr: string[];
}

function spawnAppServer(logger: pino.Logger, label: string): AppServer {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "OPENAI_API_KEY") env[key] = value;
  }
  const child = spawn("codex", ["app-server", "--enable", "realtime_conversation"], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  const recorder = new Recorder();
  const stderr: string[] = [];
  child.stderr.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (!line.trim()) continue;
      stderr.push(line);
      if (/realtime|error|warn|panic/i.test(line)) {
        process.stdout.write(`[${label} stderr] ${line.slice(0, 300)}\n`);
      }
    }
  });
  const client = new CodexAppServerClient(child, logger);
  client.setNotificationHandler((method, params) => recorder.record(method, params));
  client.onClose((reason) => {
    recorder.transportClosed = reason;
  });
  client.setRequestHandler("item/commandExecution/requestApproval", () => ({
    decision: "decline",
  }));
  client.setRequestHandler("item/fileChange/requestApproval", () => ({ decision: "decline" }));
  return { child, client, recorder, stderr };
}

async function initialize(server: AppServer): Promise<void> {
  await withTimeout(
    "initialize",
    INIT_TIMEOUT_MS,
    server.client.request("initialize", {
      clientInfo: {
        name: "paseo-assistant-realtime-smoke",
        title: "Paseo smoke",
        version: "0.0.0",
      },
      capabilities: { experimentalApi: true },
    }),
  );
  server.client.notify("initialized", {});
}

const THREAD_CONFIG = {
  ...CODEX_LIVE_VOICE_PROVIDER_OPTIONS,
  // Thread-level config merges rather than replaces, so this does not actually
  // suppress the user's configured MCP servers; kept as documentation of intent.
  mcp_servers: {},
};

async function resolveBackingModel(
  client: CodexAppServerClient,
): Promise<{ model: string; note: string }> {
  const response = (await client.request("model/list", { includeHidden: true })) as {
    data?: { id?: string; model?: string; hidden?: boolean }[];
  };
  const ids = (response.data ?? []).map((entry) => entry.model ?? entry.id ?? "?");
  if (ids.includes(BACKING_MODEL)) {
    return { model: BACKING_MODEL, note: `catalog has ${BACKING_MODEL}` };
  }
  return {
    model: BACKING_MODEL,
    note: `${BACKING_MODEL} NOT in catalog (${ids.length} models: ${ids.slice(0, 12).join(", ")}...); codex will fall back to its default`,
  };
}

interface StartOutcome {
  startedAt: number;
  version: string | null;
  echoedSessionId: string | null;
  peerState: string | null;
}

class RealtimeDriver {
  constructor(
    readonly server: AppServer,
    readonly threadId: string,
    readonly peer: WebrtcPeer | null,
  ) {}

  async start(realtimeSessionId: string, extra: Record<string, unknown>): Promise<StartOutcome> {
    const recorder = this.server.recorder;
    const since = recorder.now();
    const transport: Transport = this.peer
      ? { type: "webrtc", sdp: await this.peer.createOffer(realtimeSessionId) }
      : { type: "websocket" };
    await withTimeout(
      "thread/realtime/start",
      START_TIMEOUT_MS,
      this.server.client.request("thread/realtime/start", {
        threadId: this.threadId,
        outputModality: "audio",
        version: "v3",
        model: REALTIME_MODEL,
        transport,
        realtimeSessionId,
        includeStartupContext: false,
        prompt: PROMPT,
        ...extra,
      }),
    );
    const failFast = () => {
      const error = recorder.find("thread/realtime/error", since);
      if (error) {
        throw new Error(
          `realtime error before start: ${String((error.params as { message: string }).message)}`,
        );
      }
    };
    let peerState: string | null = null;
    if (this.peer) {
      const sdp = await waitFor("thread/realtime/sdp", START_TIMEOUT_MS, () => {
        failFast();
        return recorder.find("thread/realtime/sdp", since);
      });
      peerState = await this.peer.applyAnswer(
        realtimeSessionId,
        (sdp.params as { sdp: string }).sdp,
      );
    }
    const started = await waitFor("thread/realtime/started", START_TIMEOUT_MS, () => {
      failFast();
      return recorder.find("thread/realtime/started", since);
    });
    const params = started.params as { realtimeSessionId?: string | null; version?: string };
    return {
      startedAt: started.at,
      version: params.version ?? null,
      echoedSessionId: params.realtimeSessionId ?? null,
      peerState,
    };
  }

  async appendUserText(text: string): Promise<number> {
    const at = this.server.recorder.now();
    await this.server.client.request("thread/realtime/appendText", {
      threadId: this.threadId,
      text,
      role: "user",
    });
    process.stdout.write(`[smoke +${at}ms] appendText(user) ${JSON.stringify(text)}\n`);
    return at;
  }

  async waitForAssistantReply(
    since: number,
    expect: RegExp,
    label: string,
  ): Promise<{ text: string; latencyMs: number; matched: boolean }> {
    const recorder = this.server.recorder;
    const reply = await waitFor(`assistant transcript for ${label}`, REPLY_TIMEOUT_MS, () => {
      const error = recorder.find("thread/realtime/error", since);
      if (error) {
        throw new Error(
          `realtime error while waiting for ${label}: ${String((error.params as { message: string }).message)}`,
        );
      }
      if (recorder.transportClosed) {
        throw new Error(`transport closed while waiting for ${label}: ${recorder.transportClosed}`);
      }
      return recorder.transcriptsDone("assistant", since)[0];
    });
    return { text: reply.text, latencyMs: reply.at - since, matched: expect.test(reply.text) };
  }

  async stop(realtimeSessionId: string): Promise<string | null> {
    const recorder = this.server.recorder;
    const since = recorder.now();
    await withTimeout(
      "thread/realtime/stop",
      STOP_TIMEOUT_MS,
      this.server.client.request("thread/realtime/stop", { threadId: this.threadId }),
    );
    const closed = await waitFor("thread/realtime/closed", STOP_TIMEOUT_MS, () =>
      recorder.find("thread/realtime/closed", since),
    );
    await this.peer?.closeConnection(realtimeSessionId);
    return (closed.params as { reason?: string | null }).reason ?? null;
  }
}

interface TimelineRealtimeEntry {
  position: number;
  item: {
    id: string;
    realtimeSessionId: string;
    type: string;
    role?: string;
    text?: string;
    outcome?: string;
  };
}

async function listRealtimeTimeline(
  client: CodexAppServerClient,
  threadId: string,
): Promise<TimelineRealtimeEntry[]> {
  const entries: TimelineRealtimeEntry[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page += 1) {
    const response = (await client.request("thread/timeline/list", {
      threadId,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    })) as {
      data?: { type: string; position: number; item?: unknown }[];
      nextCursor?: string | null;
    };
    for (const entry of response.data ?? []) {
      if (entry.type === "realtime") {
        entries.push(entry as unknown as TimelineRealtimeEntry);
      }
    }
    cursor = response.nextCursor ?? null;
    if (!cursor) break;
  }
  return entries;
}

function summarizeItems(entries: TimelineRealtimeEntry[]): string {
  return entries
    .map(
      (entry) =>
        `    #${entry.position} ${entry.item.type} id=${entry.item.id} session=${entry.item.realtimeSessionId}` +
        (entry.item.text !== undefined
          ? ` ${entry.item.role}: ${JSON.stringify(entry.item.text.slice(0, 100))}`
          : "") +
        (entry.item.outcome !== undefined ? ` outcome=${entry.item.outcome}` : ""),
    )
    .join("\n");
}

interface SmokeContext {
  logger: pino.Logger;
  cwd: string;
  server: AppServer;
  peer: WebrtcPeer | null;
  threadId: string;
  note: (line: string) => void;
}

function sessionId(suffix: string): string {
  return `assistant-smoke-${Date.now().toString(36)}-${suffix}`;
}

async function startThread(
  server: AppServer,
  cwd: string,
  note: SmokeContext["note"],
): Promise<string> {
  let done = step("resolving backing model");
  const backing = await resolveBackingModel(server.client);
  done(backing.note);
  note(`backing model request: ${backing.model} (${backing.note})`);

  done = step("thread/start (restricted live-voice profile)");
  const startResponse = (await withTimeout(
    "thread/start",
    INIT_TIMEOUT_MS,
    server.client.request("thread/start", {
      model: backing.model,
      cwd,
      developerInstructions: "Automated smoke test. Never run commands.",
      config: THREAD_CONFIG,
    }),
  )) as { thread?: { id?: string }; model?: string };
  const threadId = startResponse.thread?.id;
  if (!threadId) throw new Error("thread/start returned no thread id");
  done(`thread ${threadId}, resolved model ${String(startResponse.model)}`);
  note(`thread ${threadId} backing model resolved by codex: ${String(startResponse.model)}`);
  return threadId;
}

/** Phase 0: websocket transport probe, no SDP and no browser. */
async function probeWebsocket(
  context: SmokeContext,
): Promise<{ driver: RealtimeDriver; activeSession: string | null }> {
  const done = step("phase 0: websocket transport probe (no SDP)");
  const driver = new RealtimeDriver(context.server, context.threadId, null);
  const probeSession = sessionId("ws");
  try {
    const probe = await driver.start(probeSession, {});
    done(`websocket accepted, session ${String(probe.echoedSessionId)}`);
    context.note("phase0 websocket transport: ACCEPTED (an API key must be configured for codex)");
    return { driver, activeSession: probeSession };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    done(`websocket rejected: ${message}`);
    context.note(
      `phase0 websocket transport (no SDP) under current codex auth: REJECTED — ${message}`,
    );
    return { driver, activeSession: null };
  }
}

/** Phase 1: text in, finalized transcript out, plus two quick queued messages. */
async function runPhase1(
  context: SmokeContext,
  driver: RealtimeDriver,
  reusedSession: string | null,
): Promise<void> {
  const { server, note } = context;
  let activeSession = reusedSession;
  if (activeSession) {
    note("phase1 reuses the websocket session from phase 0");
  } else {
    const done = step("phase 1: realtime start over webrtc (headless Chrome peer)");
    activeSession = sessionId("a");
    const started = await driver.start(activeSession, {});
    done(
      `started at +${started.startedAt}ms, echoed session=${String(started.echoedSessionId)}, version=${String(started.version)}, peer=${String(started.peerState)}`,
    );
    note(
      `phase1 start (webrtc): requested session ${activeSession}, echoed ${String(started.echoedSessionId)}, version ${String(started.version)}`,
    );
  }

  const ask1 = await driver.appendUserText("Say the single word pineapple and nothing else.");
  const reply1 = await driver.waitForAssistantReply(ask1, /pineapple/i, "phase1 reply");
  note(
    `phase1 reply (+${reply1.latencyMs}ms, matched=${reply1.matched}): ${JSON.stringify(reply1.text)}`,
  );

  const askQ = server.recorder.now();
  await Promise.all([
    driver.appendUserText("First quick question: what is two plus two?"),
    driver.appendUserText("Second quick question: what color is a ripe banana?"),
  ]);
  const queuedDeadline = Date.now() + REPLY_TIMEOUT_MS;
  while (
    Date.now() < queuedDeadline &&
    server.recorder.transcriptsDone("assistant", askQ).length < 2
  ) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const queuedReplies = server.recorder.transcriptsDone("assistant", askQ);
  note(
    `phase1 queued: ${queuedReplies.length} assistant transcript/done in ${REPLY_TIMEOUT_MS}ms window: ` +
      queuedReplies
        .map((r) => `(+${r.at - askQ}ms) ${JSON.stringify(r.text.slice(0, 120))}`)
        .join(" | "),
  );
  note(`phase1 user-role transcript/done count: ${server.recorder.transcriptsDone("user").length}`);
  const items1 = server.recorder.completedItems();
  note(
    `phase1 item/completed: ${items1.length} (${items1.map((i) => `${String(i.item.type)}:${String(i.item.id).slice(0, 8)}`).join(", ")})`,
  );

  const done = step("phase 1: stop");
  const closed = await driver.stop(activeSession);
  done(`closed reason=${String(closed)}`);
  note(
    `phase1 stop: closed reason ${String(closed)}; audio chunks discarded ${server.recorder.audioChunks} (${server.recorder.audioBase64Chars} b64 chars)`,
  );
}

/** Phase 2: same thread, fresh session seeded through initialItems. */
async function runPhase2(context: SmokeContext, driver: RealtimeDriver): Promise<void> {
  const { note } = context;
  const done = step("phase 2: realtime restart on same thread with initialItems");
  const session = sessionId("b");
  const started = await driver.start(session, { initialItems: SEEDED_FACT_ITEMS });
  done(`echoed session=${String(started.echoedSessionId)}`);
  const ask = await driver.appendUserText("What is my houseplant's name?");
  const reply = await driver.waitForAssistantReply(ask, /bartholomew/i, "phase2 recall");
  note(
    `phase2 seeded recall (+${reply.latencyMs}ms, matched=${reply.matched}): ${JSON.stringify(reply.text)}`,
  );
  const askCross = await driver.appendUserText(
    "Earlier in this conversation I asked you to say one specific word. Which word was it?",
  );
  const replyCross = await driver.waitForAssistantReply(
    askCross,
    /pineapple/i,
    "phase2 cross-session recall",
  );
  note(
    `phase2 cross-session recall without seeding (+${replyCross.latencyMs}ms, matched=${replyCross.matched}): ${JSON.stringify(replyCross.text)}`,
  );
  const closed = await driver.stop(session);
  note(`phase2 stop: closed reason ${String(closed)}`);
}

/** Phase 3: fresh app-server, thread/resume, journal from the timeline, recall. */
async function runPhase3(
  context: SmokeContext,
  timelineBefore: TimelineRealtimeEntry[],
): Promise<AppServer> {
  const { note, threadId } = context;
  let done = step("phase 3: disposing app-server #1 and spawning #2");
  await context.server.client.dispose();
  const server = spawnAppServer(context.logger, "codex#2");
  await initialize(server);
  done();

  done = step("phase 3: thread/resume");
  const resumeResponse = (await withTimeout(
    "thread/resume",
    INIT_TIMEOUT_MS,
    server.client.request("thread/resume", { threadId, config: THREAD_CONFIG }),
  )) as { thread?: { id?: string; turns?: unknown[] }; model?: string };
  const turnCount = resumeResponse.thread?.turns?.length ?? 0;
  done(
    `thread ${String(resumeResponse.thread?.id)}, ${turnCount} turns, model ${String(resumeResponse.model)}`,
  );
  note(`phase3 resume: ${turnCount} ordinary turns, model ${String(resumeResponse.model)}`);

  const timelineAfter = await listRealtimeTimeline(server.client, threadId);
  note(
    `timeline after restart (${timelineAfter.length} realtime entries):\n${summarizeItems(timelineAfter)}`,
  );
  const sameIds =
    timelineAfter.length === timelineBefore.length &&
    timelineAfter.every((entry, index) => entry.item.id === timelineBefore[index]?.item.id);
  note(`timeline item ids stable across restart: ${sameIds}`);

  const journal = timelineAfter
    .filter(
      (entry) => entry.item.type === "transcriptSegment" && entry.item.text && entry.item.role,
    )
    .map((entry) => ({
      role: entry.item.role === "assistant" ? ("assistant" as const) : ("user" as const),
      text: entry.item.text as string,
    }));
  const initialItems = [
    {
      role: "developer" as const,
      text: "This session continues an earlier conversation. Its transcript follows as prior turns.",
    },
    ...journal,
  ];
  const driver = new RealtimeDriver(server, threadId, context.peer);
  done = step(`phase 3: realtime start with ${initialItems.length} reconstructed initialItems`);
  const session = sessionId("c");
  const started = await driver.start(session, { initialItems });
  done(`echoed session=${String(started.echoedSessionId)}`);
  const ask = await driver.appendUserText(
    "In our earlier conversation I asked you to say one specific word. Which word was it?",
  );
  const reply = await driver.waitForAssistantReply(ask, /pineapple/i, "phase3 journal recall");
  note(
    `phase3 journal recall after restart (+${reply.latencyMs}ms, matched=${reply.matched}): ${JSON.stringify(reply.text)}`,
  );
  const closed = await driver.stop(session);
  note(`phase3 stop: closed reason ${String(closed)}`);
  return server;
}

function printFailure(error: unknown, server: AppServer | null, report: string[]): void {
  process.stdout.write(
    `\n[smoke] FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  if (server) {
    const tail = server.recorder.events
      .slice(-12)
      .map((event) => `  ${event.at}ms ${describe(event.method, event.params)}`);
    process.stdout.write(`[smoke] last events:\n${tail.join("\n")}\n`);
    const stderrTail = server.stderr.slice(-15).map((line) => `  ${line.slice(0, 300)}`);
    process.stdout.write(`[smoke] codex stderr tail:\n${stderrTail.join("\n")}\n`);
  }
  process.stdout.write(
    `[smoke] partial report:\n${report.map((line) => `  - ${line}`).join("\n")}\n`,
  );
}

async function main(): Promise<void> {
  const logger = pino({ level: "warn" });
  const cwd = await mkdtemp(path.join(os.tmpdir(), "paseo-assistant-realtime-smoke-"));
  const report: string[] = [];
  const note = (line: string) => {
    report.push(line);
    process.stdout.write(`[report] ${line}\n`);
  };
  let server: AppServer | null = null;
  let peer: WebrtcPeer | null = null;

  try {
    const done = step("spawning private codex app-server (--enable realtime_conversation)");
    server = spawnAppServer(logger, "codex#1");
    await initialize(server);
    done();
    const threadId = await startThread(server, cwd, note);
    const context: SmokeContext = { logger, cwd, server, peer: null, threadId, note };

    const probe = await probeWebsocket(context);
    let driver = probe.driver;
    if (!probe.activeSession) {
      const launched = step("launching headless Chrome as WebRTC media peer");
      peer = new WebrtcPeer();
      await peer.open();
      context.peer = peer;
      driver = new RealtimeDriver(server, threadId, peer);
      launched();
    }

    await runPhase1(context, driver, probe.activeSession);
    await runPhase2(context, driver);

    const timelineBefore = await listRealtimeTimeline(server.client, threadId);
    note(
      `timeline before restart (${timelineBefore.length} realtime entries):\n${summarizeItems(timelineBefore)}`,
    );

    if (SKIP_RESTART) {
      note("restart phase skipped (ASSISTANT_SMOKE_SKIP_RESTART=1)");
    } else {
      server = await runPhase3(context, timelineBefore);
    }

    note(`codex thread kept for inspection: ${threadId} (rollout under $CODEX_HOME/sessions)`);
    process.stdout.write(`\n[smoke] PASS\n${report.map((line) => `  - ${line}`).join("\n")}\n`);
  } catch (error) {
    printFailure(error, server, report);
    process.exitCode = 1;
  } finally {
    await peer?.close();
    await server?.client.dispose().catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  }
}

void main();
