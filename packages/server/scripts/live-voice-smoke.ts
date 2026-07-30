/**
 * End-to-end Live Voice smoke against a real codex CLI and real OpenAI backend.
 *
 * Spins an isolated in-process daemon (never touches port 6767), creates a codex
 * agent, then drives the full phase-1 client path: a real Chrome builds the
 * WebRTC offer (audio transceiver + `oai-events` data channel + full ICE
 * gathering), the daemon relays it through `voice.live.start`, and the script
 * asserts the answer SDP applies, the peer connection reaches `connected`, the
 * provider's `session.started` arrives on the data channel, and stop tears the
 * call down with a `closed` update.
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

async function main(): Promise<void> {
  const logger = pino({ level: "warn" });
  const paseoHomeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-live-voice-smoke-"));
  const paseoHome = path.join(paseoHomeRoot, ".paseo");
  const staticDir = path.join(paseoHomeRoot, "static");
  const agentCwd = path.join(paseoHomeRoot, "agent-cwd");
  await mkdir(paseoHome, { recursive: true });
  await mkdir(staticDir, { recursive: true });
  await mkdir(agentCwd, { recursive: true });

  let done = step("starting in-process daemon");
  const daemon = await createPaseoDaemon(
    {
      listen: "127.0.0.1:0",
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: false,
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

    done = step("creating codex agent");
    const agent = await withTimeout(
      "createAgent",
      client.createAgent({ provider: "codex", cwd: agentCwd }),
    );
    if (agent.capabilities?.supportsLiveVoice !== true) {
      throw new Error(
        `agent.capabilities.supportsLiveVoice is ${String(agent.capabilities?.supportsLiveVoice)} — spawn flag/version gate did not surface`,
      );
    }
    done(`agent ${agent.id}, supportsLiveVoice=true`);

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
    const accepted = await withTimeout(
      "startLiveVoice",
      client.startLiveVoice({ agentId: agent.id, offerSdp }),
    );
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
    const startedModel = (connectionResult.sessionStarted as { session?: { model?: string } })
      .session?.model;
    done(`state=${connectionResult.state}, model=${String(startedModel)}`);

    const sawStartedUpdate = updates.some((update) => update.event.kind === "started");
    if (!sawStartedUpdate) {
      throw new Error("no voice.live.update {kind:'started'} reached the owning client");
    }

    done = step("stopping call");
    await withTimeout(
      "stopLiveVoice",
      client.stopLiveVoice({ agentId: agent.id, liveSessionId: accepted.liveSessionId }),
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
