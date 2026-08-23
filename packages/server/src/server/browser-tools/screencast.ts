import {
  encodeBrowserScreencastFrame,
  type BrowserScreencastFrame,
} from "@getpaseo/protocol/binary-frames/screencast";
import type { BrowserToolsBroker } from "./broker.js";

const SCREENCAST_SLOT_COUNT = 256;
const SCREENCAST_QUALITY = 60;
const SCREENCAST_MAX_WIDTH = 1280;
const SCREENCAST_MAX_HEIGHT = 800;

export interface BrowserScreencastViewer {
  sendFrame(frame: Uint8Array): void;
}

export type BrowserScreencastSubscription =
  | { ok: true; slot: number }
  | { ok: false; error: string };

interface BrowserScreencastStream {
  browserId: string;
  slot: number;
  viewers: Set<BrowserScreencastViewer>;
  /** Settles when `screencast_start` has been answered, so a stop cannot race it. */
  started: Promise<unknown>;
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

  public constructor(broker: Pick<BrowserToolsBroker, "execute">) {
    this.broker = broker;
  }

  public async subscribe(params: {
    viewer: BrowserScreencastViewer;
    browserId: string;
  }): Promise<BrowserScreencastSubscription> {
    const existing = this.streams.get(params.browserId);
    if (existing) {
      existing.viewers.add(params.viewer);
      return { ok: true, slot: existing.slot };
    }

    const slot = this.allocateSlot();
    if (slot === null) {
      return { ok: false, error: "All browser screencast slots are in use." };
    }

    const started = this.broker.execute({
      command: {
        command: "screencast_start",
        args: {
          browserId: params.browserId,
          slot,
          quality: SCREENCAST_QUALITY,
          maxWidth: SCREENCAST_MAX_WIDTH,
          maxHeight: SCREENCAST_MAX_HEIGHT,
          everyNthFrame: 1,
        },
      },
    });
    const stream: BrowserScreencastStream = {
      browserId: params.browserId,
      slot,
      viewers: new Set([params.viewer]),
      started,
    };
    this.streams.set(params.browserId, stream);
    this.streamsBySlot.set(slot, stream);

    const payload = await started;
    if (!payload.ok) {
      this.release(stream);
      return { ok: false, error: payload.error.message };
    }
    return { ok: true, slot };
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
      return;
    }
    this.release(stream);
    await stream.started;
    await this.broker.execute({
      command: { command: "screencast_stop", args: { browserId: params.browserId } },
    });
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
    for (const viewer of stream.viewers) {
      viewer.sendFrame(bytes);
    }
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
