import {
  BrowserScreencastOpcode,
  encodeBrowserScreencastFrame,
  type BrowserScreencastBinaryFrame,
} from "@getpaseo/protocol/binary-frames/index";
import { BrowserToolsRequestError } from "../../browser-tools/errors.js";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { DaemonPlaywrightHost, ScreencastFrame } from "../../verify/playwright-host.js";
import type { SessionDelivery } from "../owned-subscriptions/index.js";
import type { BrowserScreencastQuality } from "@getpaseo/protocol/browser-screencast/rpc-schemas";

// Chromium only sends a frame when the page repaints, so the cap costs nothing while
// idle; at 12 a trackpad scroll visibly stepped.
export const SCREENCAST_MAX_FPS = 30;

interface ScreencastPreset {
  maxFps: number;
  jpegQuality: number;
  /** Chromium downscales frames wider than this; saves bytes on a phone on cellular. */
  maxWidth?: number;
}

export const SCREENCAST_PRESETS: Record<BrowserScreencastQuality, ScreencastPreset> = {
  smooth: { maxFps: SCREENCAST_MAX_FPS, jpegQuality: 70 },
  sharp: { maxFps: SCREENCAST_MAX_FPS, jpegQuality: 90 },
  saver: { maxFps: 10, jpegQuality: 50, maxWidth: 960 },
};
// Two frames in flight hide one round trip without letting a slow link build a backlog.
export const SCREENCAST_MAX_UNACKED_FRAMES = 2;
const MAX_SCREENCAST_SLOTS = 256;

interface ScreencastPacerOptions<T> {
  send(frame: T, sequence: number): Promise<void>;
  minIntervalMs: number;
  maxUnacked: number;
}

/**
 * Latest frame wins. A frame goes out only when the previous write finished, fewer than
 * maxUnacked frames await the viewer's ack, and minIntervalMs passed since the last send.
 * The first frame after an idle period goes out immediately; a trailing timer sends the last one.
 */
export class ScreencastPacer<T> {
  private latest: T | null = null;
  private sent = 0;
  private acked = 0;
  private writing = false;
  private paused = true;
  private stopped = false;
  private nextSendAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: ScreencastPacerOptions<T>) {}

  push(frame: T): void {
    this.latest = frame;
    this.pump();
  }

  resume(): void {
    this.paused = false;
    this.pump();
  }

  ack(sequence: number): void {
    if (sequence <= this.acked || sequence > this.sent) return;
    this.acked = sequence;
    this.pump();
  }

  stop(): void {
    this.stopped = true;
    this.latest = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private pump(): void {
    const isBlocked = this.paused || this.stopped || this.writing || this.timer !== null;
    const isWindowFull = this.sent - this.acked >= this.options.maxUnacked;
    if (isBlocked || isWindowFull || this.latest === null) return;
    const wait = this.nextSendAt - Date.now();
    if (wait > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pump();
      }, wait);
      return;
    }
    const frame = this.latest;
    this.latest = null;
    this.writing = true;
    this.sent += 1;
    this.nextSendAt = Date.now() + this.options.minIntervalMs;
    void this.options.send(frame, this.sent).finally(() => {
      this.writing = false;
      this.pump();
    });
  }
}

interface ActiveScreencast {
  source: object;
  pacer: ScreencastPacer<ScreencastFrame>;
}

export interface BrowserScreencastSessionOptions {
  host: Pick<DaemonPlaywrightHost, "startScreencast"> | null | undefined;
  emit: (message: SessionOutboundMessage) => void;
}

/** One pacer per viewer subscription; frames and acks share the subscription's binary slot. */
export class BrowserScreencastSession {
  private readonly streams = new Map<number, ActiveScreencast>();
  private nextSlot = 0;

  constructor(private readonly options: BrowserScreencastSessionOptions) {}

  async subscribe(
    request: Extract<SessionInboundMessage, { type: "browser.screencast.subscribe.request" }>,
    delivery: SessionDelivery,
  ): Promise<void> {
    const { requestId, workspaceId, browserId } = request;
    const preset = SCREENCAST_PRESETS[request.quality ?? "smooth"];
    const fail = (error: string) =>
      this.options.emit({
        type: "browser.screencast.subscribe.response",
        payload: { requestId, browserId, error },
      });
    const host = this.options.host;
    if (!host) return fail("Remote browser hosting is unavailable.");
    const slot = this.allocateSlot();
    if (slot === null) return fail("No browser screencast slots available.");

    let stop: (() => Promise<void>) | null = null;
    const pacer = new ScreencastPacer<ScreencastFrame>({
      minIntervalMs: 1000 / preset.maxFps,
      maxUnacked: SCREENCAST_MAX_UNACKED_FRAMES,
      send: (frame, sequence) =>
        owner.emitBinary(
          encodeBrowserScreencastFrame({
            slot,
            sequence,
            width: frame.width,
            height: frame.height,
            payload: Buffer.from(frame.dataBase64, "base64"),
          }),
        ),
    });
    const owner = delivery.begin(
      "browser-screencast",
      undefined,
      async () => {
        pacer.stop();
        this.streams.delete(slot);
        await stop?.();
      },
      `browser-screencast:${browserId}`,
    );
    this.streams.set(slot, { source: owner.source, pacer });
    try {
      stop = await host.startScreencast({
        workspaceId,
        browserId,
        jpegQuality: preset.jpegQuality,
        ...(preset.maxWidth ? { maxWidth: preset.maxWidth } : {}),
        onFrame: (frame) => pacer.push(frame),
        onEnd: () => {
          owner.emit({ type: "browser.screencast.ended", payload: { browserId } });
          void owner.release();
        },
      });
    } catch (error) {
      await owner.release();
      if (error instanceof BrowserToolsRequestError) return fail(error.message);
      throw error;
    }
    if (owner.signal.aborted) {
      await stop();
      return;
    }
    this.options.emit({
      type: "browser.screencast.subscribe.response",
      payload: { requestId, browserId, subscriptionId: owner.responseId, slot, error: null },
    });
    // Frames wait for the response so the viewer has the slot before its first frame.
    pacer.resume();
  }

  handleFrame(frame: BrowserScreencastBinaryFrame, source: object): void {
    if (frame.opcode !== BrowserScreencastOpcode.Ack) return;
    const stream = this.streams.get(frame.slot);
    if (stream?.source === source) stream.pacer.ack(frame.sequence);
  }

  private allocateSlot(): number | null {
    for (let offset = 0; offset < MAX_SCREENCAST_SLOTS; offset += 1) {
      const slot = (this.nextSlot + offset) % MAX_SCREENCAST_SLOTS;
      if (!this.streams.has(slot)) {
        this.nextSlot = (slot + 1) % MAX_SCREENCAST_SLOTS;
        return slot;
      }
    }
    return null;
  }
}
