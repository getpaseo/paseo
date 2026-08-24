import {
  encodeBrowserScreencastFrame,
  type BrowserScreencastFrame,
} from "@getpaseo/protocol/binary-frames/screencast";
import type { BrowserToolsBroker } from "./broker.js";
import type { BrowserToolsResponsePayload } from "./errors.js";

const SCREENCAST_SLOT_COUNT = 256;
// A pane that remounts unsubscribes before it subscribes again. Stopping in
// between would race the new start to the host and could land after it, leaving
// the daemon with a stream the host is no longer capturing.
const SCREENCAST_STOP_GRACE_MS = 250;
// One quality for every frame: a viewer that sees motion drop to a cheaper tier
// and climb back reads as flicker, which is worse than the bandwidth it saves.
const SCREENCAST_QUALITY = 90;
// What a viewer that declares no size gets: an app old enough to not send caps.
const DEFAULT_SCREENCAST_SIZE: BrowserScreencastSize = { maxWidth: 2560, maxHeight: 1600 };

export interface BrowserScreencastViewer {
  sendFrame(frame: Uint8Array): void;
}

/** Device pixels a viewer can display. */
export interface BrowserScreencastSize {
  maxWidth: number;
  maxHeight: number;
}

export type BrowserScreencastSubscription =
  | { ok: true; slot: number; replay: Uint8Array | null }
  | { ok: false; error: string };

interface BrowserScreencastStream {
  browserId: string;
  slot: number;
  viewers: Map<BrowserScreencastViewer, BrowserScreencastSize>;
  /** What the host is capturing at: the largest size across `viewers`. */
  size: BrowserScreencastSize;
  /** Settles when `screencast_start` has been answered, so a stop cannot race it. */
  started: Promise<unknown>;
  /** Chrome only emits on damage, so a late viewer needs the last frame replayed. */
  lastFrame: Uint8Array | null;
}

/**
 * One slot per mirrored browser, shared by the host and every viewer, so JPEG
 * frames are forwarded without re-encoding. The host streams while at least one
 * viewer is subscribed.
 */
export class BrowserScreencastRegistry {
  private readonly broker: Pick<BrowserToolsBroker, "execute">;
  private readonly streams = new Map<string, BrowserScreencastStream>();
  private readonly streamsBySlot = new Map<number, BrowserScreencastStream>();
  /** In-flight `screencast_stop` per browser: the next start queues behind it. */
  private readonly stopping = new Map<string, Promise<unknown>>();
  private readonly stopGraceMs: number;

  public constructor(
    broker: Pick<BrowserToolsBroker, "execute">,
    options?: { stopGraceMs?: number },
  ) {
    this.broker = broker;
    this.stopGraceMs = options?.stopGraceMs ?? SCREENCAST_STOP_GRACE_MS;
  }

  public async subscribe(params: {
    viewer: BrowserScreencastViewer;
    browserId: string;
    maxWidth?: number;
    maxHeight?: number;
  }): Promise<BrowserScreencastSubscription> {
    const size: BrowserScreencastSize = {
      maxWidth: params.maxWidth ?? DEFAULT_SCREENCAST_SIZE.maxWidth,
      maxHeight: params.maxHeight ?? DEFAULT_SCREENCAST_SIZE.maxHeight,
    };
    const existing = this.streams.get(params.browserId);
    if (existing) {
      existing.viewers.set(params.viewer, size);
      this.resize(existing);
      // Every subscribe replays: a pane that remounts drops its slot mapping and
      // its decoded frame, and a settled page emits nothing to redraw it with. On
      // a resize the replay is superseded by the re-armed capture's first frame.
      // The caller sends it after the subscribe response: a frame that beats the
      // response arrives before the viewer has mapped the slot, and is dropped.
      return { ok: true, slot: existing.slot, replay: existing.lastFrame };
    }

    const slot = this.allocateSlot();
    if (slot === null) {
      return { ok: false, error: "All browser screencast slots are in use." };
    }

    const started = afterSettled(this.stopping.get(params.browserId), () =>
      this.start({ browserId: params.browserId, slot, size }),
    );
    const stream: BrowserScreencastStream = {
      browserId: params.browserId,
      slot,
      viewers: new Map([[params.viewer, size]]),
      size,
      started,
      lastFrame: null,
    };
    this.streams.set(params.browserId, stream);
    this.streamsBySlot.set(slot, stream);

    const payload = await started;
    if (!payload.ok) {
      this.release(stream);
      return { ok: false, error: payload.error.message };
    }
    return { ok: true, slot, replay: null };
  }

  public async unsubscribe(params: {
    viewer: BrowserScreencastViewer;
    browserId: string;
  }): Promise<void> {
    const stream = this.streams.get(params.browserId);
    if (!stream) {
      return;
    }
    stream.viewers.delete(params.viewer);
    if (stream.viewers.size > 0) {
      this.resize(stream);
      return;
    }
    await delay(this.stopGraceMs);
    // The stream stays registered through the grace, so a viewer that comes back
    // rejoins the capture already running instead of re-arming it.
    if (stream.viewers.size > 0 || this.streams.get(params.browserId) !== stream) {
      return;
    }
    // Registered before the slot is released, so a subscribe arriving while the
    // stop is in flight queues its start behind it instead of overtaking it.
    const stop = afterSettled(stream.started, () =>
      this.broker.execute({
        command: { command: "screencast_stop", args: { browserId: params.browserId } },
      }),
    );
    this.stopping.set(params.browserId, stop);
    this.release(stream);
    try {
      await stop;
    } finally {
      if (this.stopping.get(params.browserId) === stop) {
        this.stopping.delete(params.browserId);
      }
    }
  }

  public async removeViewer(viewer: BrowserScreencastViewer): Promise<void> {
    const subscribed = Array.from(this.streams.values()).filter((stream) =>
      stream.viewers.has(viewer),
    );
    await Promise.all(
      subscribed.map((stream) => this.unsubscribe({ viewer, browserId: stream.browserId })),
    );
  }

  public handleFrame(frame: BrowserScreencastFrame): void {
    const stream = this.streamsBySlot.get(frame.slot);
    if (!stream) {
      return;
    }
    const bytes = encodeBrowserScreencastFrame(frame);
    stream.lastFrame = bytes;
    for (const viewer of stream.viewers.keys()) {
      viewer.sendFrame(bytes);
    }
  }

  private start(params: {
    browserId: string;
    slot: number;
    size: BrowserScreencastSize;
  }): Promise<BrowserToolsResponsePayload> {
    return this.broker.execute({
      command: {
        command: "screencast_start",
        args: {
          browserId: params.browserId,
          slot: params.slot,
          quality: SCREENCAST_QUALITY,
          maxWidth: params.size.maxWidth,
          maxHeight: params.size.maxHeight,
          everyNthFrame: 1,
        },
      },
    });
  }

  /**
   * One capture serves every viewer, so it runs at the largest one. Re-arming
   * costs a frame, so only a changed size re-issues; the host stops the running
   * stream before starting the new one, which keeps the slot valid throughout.
   * The re-arm queues behind the command already in flight, so the host's last
   * screencast command for the browser is always the registry's last decision.
   */
  private resize(stream: BrowserScreencastStream): void {
    const size = largestSize(stream.viewers);
    if (size.maxWidth === stream.size.maxWidth && size.maxHeight === stream.size.maxHeight) {
      return;
    }
    stream.size = size;
    stream.started = afterSettled(stream.started, () =>
      this.start({ browserId: stream.browserId, slot: stream.slot, size }),
    );
  }

  private allocateSlot(): number | null {
    for (let slot = 0; slot < SCREENCAST_SLOT_COUNT; slot += 1) {
      if (!this.streamsBySlot.has(slot)) {
        return slot;
      }
    }
    return null;
  }

  private release(stream: BrowserScreencastStream): void {
    if (this.streams.get(stream.browserId) !== stream) {
      return;
    }
    this.streams.delete(stream.browserId);
    this.streamsBySlot.delete(stream.slot);
  }
}

function largestSize(
  viewers: Map<BrowserScreencastViewer, BrowserScreencastSize>,
): BrowserScreencastSize {
  let maxWidth = 0;
  let maxHeight = 0;
  for (const size of viewers.values()) {
    maxWidth = Math.max(maxWidth, size.maxWidth);
    maxHeight = Math.max(maxHeight, size.maxHeight);
  }
  return { maxWidth, maxHeight };
}

/**
 * Queues a host command behind the one before it, so the host receives them in
 * the order the registry decided them. A failed command does not block the next.
 */
function afterSettled<T>(
  previous: Promise<unknown> | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (!previous) {
    return run();
  }
  return previous.then(run, run);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
