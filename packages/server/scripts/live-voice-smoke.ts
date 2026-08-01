/**
 * End-to-end Live Voice smoke against a real codex CLI and real OpenAI backend.
 *
 * Spins an isolated in-process daemon (never touches port 6767), then drives the
 * full client path: a real Chrome builds the WebRTC offer (audio transceiver +
 * `oai-events` data channel + full ICE gathering), the daemon spawns its hidden
 * host session and relays the offer through `voice.live.start`, and the script
 * asserts the answer SDP applies, the peer connection reaches `connected`, the
 * provider's `session.started` arrives on the data channel, and stop tears the
 * call down with a `closed` update.
 *
 * The call is daemon-global: no agent is created here, and the host session runs
 * in the user's home directory the way it does in production.
 *
 * Requires: `codex` on PATH with a logged-in account entitled to realtime v3,
 * and a Chrome binary (default /run/current-system/sw/bin/google-chrome,
 * override with LIVE_VOICE_SMOKE_CHROME).
 *
 * Run from packages/server: `npx tsx scripts/live-voice-smoke.ts`
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import pino from "pino";
import playwrightModule from "playwright-core";
import type { VoiceLiveUpdate } from "@getpaseo/protocol/messages";
import { createPaseoDaemon } from "../src/server/bootstrap.js";
import { DaemonClient } from "../src/server/test-utils/daemon-client.js";

const chromium = (
  "default" in playwrightModule
    ? (playwrightModule as unknown as { default: typeof playwrightModule }).default
    : playwrightModule
).chromium;

const CHROME_PATH =
  process.env.LIVE_VOICE_SMOKE_CHROME ?? "/run/current-system/sw/bin/google-chrome";
const STEP_TIMEOUT_MS = 60_000;

function step(name: string): (detail?: string) => void {
  process.stdout.write(`[smoke] ${name}...`);
  return (detail?: string) => process.stdout.write(` ok${detail ? ` (${detail})` : ""}\n`);
}

async function withTimeout<T>(label: string, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), STEP_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Captures daemon log records so the smoke can assert on daemon-internal
 * behavior that isn't visible on the wire, and keeps stdout to warnings and up.
 */
function createCapturingLogger(): { logger: pino.Logger; records: Record<string, unknown>[] } {
  const records: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of String(chunk).split("\n")) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as Record<string, unknown>;
          records.push(record);
          if (typeof record.level === "number" && record.level >= 40) {
            process.stdout.write(`[daemon] ${String(record.msg)}\n`);
          }
        } catch {
          // Non-JSON output is not a log record we care about.
        }
      }
      callback();
    },
  });
  return { logger: pino({ level: "debug" }, stream), records };
}

async function main(): Promise<void> {
  const { logger, records } = createCapturingLogger();
  const paseoHomeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-live-voice-smoke-"));
  const paseoHome = path.join(paseoHomeRoot, ".paseo");
  const staticDir = path.join(paseoHomeRoot, "static");
  await mkdir(paseoHome, { recursive: true });
  await mkdir(staticDir, { recursive: true });

  let done = step("starting in-process daemon");
  const daemon = await createPaseoDaemon(
    {
      listen: "127.0.0.1:0",
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      // Production default. Also what gives the hidden host session Paseo's own
      // MCP tools, which is what makes "act on Paseo by voice" work at all.
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      agentClients: {},
      agentStoragePath: path.join(paseoHome, "agents"),
      relayEnabled: false,
      relayEndpoint: "relay.paseo.sh:443",
      appBaseUrl: "https://app.paseo.sh",
    },
    logger,
  );
  await daemon.start();
  const target = daemon.getListenTarget();
  if (target?.type !== "tcp") {
    throw new Error("daemon did not listen on tcp");
  }
  done(`port ${target.port}`);

  const client = new DaemonClient({ url: `ws://127.0.0.1:${target.port}/ws` });
  const updates: VoiceLiveUpdate["payload"][] = [];
  client.on("voice.live.update", (message) => {
    updates.push(message.payload);
    process.stdout.write(
      `[smoke] voice.live.update seq=${message.payload.seq} kind=${message.payload.event.kind}\n`,
    );
  });

  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  let pageServer: http.Server | null = null;
  try {
    done = step("connecting client");
    await withTimeout("client connect", client.connect());
    const serverInfo = client.getLastServerInfoMessage();
    if (serverInfo?.features?.liveVoice !== true) {
      throw new Error(
        `server_info.features.liveVoice is ${String(serverInfo?.features?.liveVoice)}`,
      );
    }
    done("features.liveVoice=true");

    done = step("launching Chrome + building offer");
    browser = await chromium.launch({
      executablePath: CHROME_PATH,
      ignoreDefaultArgs: ["--mute-audio"],
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    });
    const page = await browser.newPage();
    // getUserMedia needs a potentially-trustworthy origin; about:blank is not one
    // in headless Chrome, but a page served from 127.0.0.1 is.
    pageServer = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>live-voice smoke</title>");
    });
    await new Promise<void>((resolve) => pageServer?.listen(0, "127.0.0.1", resolve));
    const pageAddress = pageServer.address();
    if (pageAddress === null || typeof pageAddress !== "object") {
      throw new Error("page server did not bind");
    }
    await page.goto(`http://127.0.0.1:${pageAddress.port}/`);
    // tsx (esbuild keepNames) injects `__name(...)` calls into the functions we
    // pass to page.evaluate; the helper doesn't exist in the browser context.
    await page.evaluate("window.__name = (target) => target");
    const offerSdp = await withTimeout(
      "offer",
      page.evaluate(async () => {
        const w = window as unknown as Record<string, unknown>;
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const pc = new RTCPeerConnection();
        w.__pc = pc;
        w.__events = [];
        for (const track of stream.getTracks()) {
          pc.addTrack(track, stream);
        }
        const channel = pc.createDataChannel("oai-events");
        channel.addEventListener("message", (event) => {
          (w.__events as string[]).push(String(event.data));
        });
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
      }),
    );
    if (!offerSdp.includes("m=audio")) {
      throw new Error("offer has no audio m-line");
    }
    done(`${offerSdp.length} chars`);

    done = step("voice.live.start via daemon");
    const accepted = await withTimeout("startLiveVoice", client.startLiveVoice({ offerSdp }));
    done(`liveSessionId ${accepted.liveSessionId}, answer ${accepted.answerSdp.length} chars`);

    done = step("applying answer + waiting for connected + session.started");
    const connectionResult = await withTimeout(
      "webrtc connected",
      page.evaluate(async (answerSdp: string) => {
        const w = window as unknown as Record<string, unknown>;
        const pc = w.__pc as RTCPeerConnection;
        await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`stuck in ${pc.connectionState}`)),
            30_000,
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
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          const events = w.__events as string[];
          const started = events.find((raw) => raw.includes("session.started"));
          if (started) {
            return { state: pc.connectionState, sessionStarted: JSON.parse(started) };
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return { state: pc.connectionState, sessionStarted: null };
      }, accepted.answerSdp),
    );
    if (connectionResult.sessionStarted === null) {
      throw new Error("session.started never arrived on oai-events");
    }
    const startedSession = (
      connectionResult.sessionStarted as {
        session?: { model?: string; instructions?: string; initial_items?: unknown[] };
      }
    ).session;
    done(`state=${connectionResult.state}, model=${String(startedSession?.model)}`);

    done = step("checking injected Paseo context");
    done(assertPaseoContext({ instructions: startedSession?.instructions, records }));

    const sawStartedUpdate = updates.some((update) => update.event.kind === "started");
    if (!sawStartedUpdate) {
      throw new Error("no voice.live.update {kind:'started'} reached the owning client");
    }

    done = step("speaking a routed work notification into the call");
    const notifyResult = await withTimeout(
      "notifyLiveVoiceAgentUpdate",
      client.notifyLiveVoiceAgentUpdate({
        liveSessionId: accepted.liveSessionId,
        notification: {
          agentId: "smoke-agent",
          title: "Smoke test session",
          reason: "finished",
          summary: "Renamed two files and ran the tests. Everything passed.",
          hostLabel: "this machine",
        },
      }),
    );
    if (!notifyResult.delivered) {
      throw new Error("the daemon did not accept the work notification");
    }
    done(await withTimeout("spoken notification", waitForSpokenNotification(page, updates)));

    done = step("stopping call");
    await withTimeout(
      "stopLiveVoice",
      client.stopLiveVoice({ liveSessionId: accepted.liveSessionId }),
    );
    const closedCause = await waitForClosedUpdate(updates);
    done(`cause=${closedCause}`);

    assertMonotonicSeq(updates);

    process.stdout.write(
      `[smoke] PASS — ${updates.length} updates (${updates.map((u) => u.event.kind).join(", ")})\n`,
    );
  } finally {
    await browser?.close().catch(() => undefined);
    pageServer?.close();
    await client.close().catch(() => undefined);
    await daemon.stop().catch(() => undefined);
    await rm(paseoHomeRoot, { recursive: true, force: true });
  }
}

/**
 * The instructions check is the real end-to-end proof: the provider echoes them
 * on `session.started`, so seeing the Paseo prompt there means it travelled
 * daemon → codex → OpenAI and was accepted. `initial_items` is *not* echoed, so
 * the seeded snapshot is verified from the daemon's own record of what it sent —
 * a malformed or over-budget snapshot would have failed the start outright.
 */
function assertPaseoContext(params: {
  instructions: string | undefined;
  records: Record<string, unknown>[];
}): string {
  const instructions = params.instructions ?? "";
  if (!instructions.includes("You are the voice of Paseo")) {
    throw new Error(
      `session instructions are not the Paseo prompt: ${instructions.slice(0, 120)}...`,
    );
  }
  const host = params.records.find((record) => record.msg === "live_voice.host.started");
  if (!host?.hostAgentId) {
    throw new Error("daemon never spawned a hidden host session");
  }
  const built = params.records.find((record) => record.msg === "live_voice.context.built");
  if (!built) {
    throw new Error("daemon never logged live_voice.context.built");
  }
  // A freshly created daemon may have no sessions and no workspaces to report,
  // so an empty snapshot is legitimate here; the prompt is the real assertion.
  if (typeof built.itemCount !== "number") {
    throw new Error(`context did not record its item count: ${JSON.stringify(built)}`);
  }
  // MCP is enabled above, so the host session must have Paseo's tools and the
  // prompt must say so — otherwise the model would refuse to act on Paseo.
  if (built.paseoToolsAvailable !== true) {
    throw new Error("Paseo MCP tools were not injected into the host session");
  }
  if (!instructions.includes("prompt an existing agent session")) {
    throw new Error("the prompt does not tell the model it can act on Paseo");
  }
  return `host ${String(host.hostAgentId)}, ${instructions.length} chars of instructions, ${String(built.itemCount)} seeded items, ${String(built.agentCount)} sessions / ${String(built.workspaceCount)} workspaces, paseoTools=${String(built.paseoToolsAvailable)}`;
}

/**
 * A notification is only worth anything if the model actually says it. The
 * provider's `response.created` on the control channel is the earliest proof it
 * decided to speak; the daemon's assistant transcript is the proof of what it
 * said. Wait for whichever lands first and report both.
 */
async function waitForSpokenNotification(
  page: Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>["newPage"]>>,
  updates: VoiceLiveUpdate["payload"][],
): Promise<string> {
  const before = updates.length;
  const deadline = Date.now() + 30_000;
  let responded = false;
  while (Date.now() < deadline) {
    if (!responded) {
      responded = await page.evaluate(() => {
        const events = (window as unknown as Record<string, unknown>).__events as string[];
        return events.some((raw) => raw.includes("response.created"));
      });
    }
    const transcript = updates
      .slice(before)
      .find((update) => update.event.kind === "transcript" && update.event.role === "assistant");
    if (transcript?.event.kind === "transcript") {
      return `responded=${String(responded)}, said "${transcript.event.text.slice(0, 120)}"`;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`the model never spoke the notification (response.created=${String(responded)})`);
}

async function waitForClosedUpdate(updates: VoiceLiveUpdate["payload"][]): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const closed = updates.find((update) => update.event.kind === "closed");
    if (closed?.event.kind === "closed") {
      return closed.event.cause;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("no closed update after stop");
}

function assertMonotonicSeq(updates: VoiceLiveUpdate["payload"][]): void {
  const seqs = updates.map((update) => update.seq);
  const monotonic = seqs.every((seq, index) => index === 0 || seq > (seqs[index - 1] as number));
  if (!monotonic) {
    throw new Error(`seq not monotonic: ${seqs.join(",")}`);
  }
}

main().catch((error) => {
  process.stderr.write(
    `\n[smoke] FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
