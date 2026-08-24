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
// The host encodes every frame to the size it is asked for, so an unbounded
// request is an unbounded encode on someone else's machine. A viewer caps itself
// to what it can display; this is the ceiling the daemon holds any client to.
const MAX_SCREENCAST_DIMENSION = 4096;
const MAX_SCREENCAST_PIXELS = 3840 * 2160;

/** What the registry needs from the broker: run host commands, and who owns a tab. */
type BrowserScreencastBroker = Pick<
  BrowserToolsBroker,
  "execute" | "getBrowserHostClientId" | "getBrowserWorkspaceId"
>;

export interface BrowserScreencastViewer {
  /** Settles once the frame has left the daemon's outbound queue. */
  sendFrame(frame: Uint8Array): Promise<void>;
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
  /** The host the capture runs on: the only sender whose frames belong on this slot. */
  hostClientId: string | null;
  /** The workspace the capture was started for, forwarded to the host with every re-arm. */
  workspaceId: string | undefined;
  viewers: Map<BrowserScreencastViewer, BrowserScreencastSize>;
  /** What the host is capturing at: the largest size across `viewers`. */
  size: BrowserScreencastSize;
  /** Settles when `screencast_start` has been answered, so a stop cannot race it. */
  started: Promise<unknown>;
  /** Chrome only emits on damage, so a late viewer needs the last frame replayed. */
  lastFrame: Uint8Array | null;
}

/** The one frame waiting behind the send a viewer has not finished yet. */
interface BrowserScreencastDelivery {
  pending: Uint8Array | null;
}

/** A `screencast_stop` the host has not answered yet. */
interface BrowserScreencastStop {
  settled: Promise<unknown>;
  /**
   * The slot the capture being stopped still runs on. Held until the host
   * answers: frames already on their way carry it, and every browser on a host
   * shares that host's identity, so a second browser handed this slot would
   * pass the owner check and paint the first one's tab.
   */
  slot: number;
}

/**
 * One slot per mirrored browser, shared by the host and every viewer, so JPEG
 * frames are forwarded without re-encoding. The host streams while at least one
 * viewer is subscribed.
 */
export class BrowserScreencastRegistry {
  private readonly broker: BrowserScreencastBroker;
  private readonly streams = new Map<string, BrowserScreencastStream>();
  private readonly streamsBySlot = new Map<number, BrowserScreencastStream>();
  /** In-flight `screencast_stop` per browser: the next start queues behind it. */
  private readonly stopping = new Map<string, BrowserScreencastStop>();
  /**
   * Per viewer, the send it has not finished plus the one frame waiting behind
   * it. Queueing every frame onto a viewer that cannot keep up would push its
   * socket past the outbound high-water mark, and crossing that terminates the
   * socket, taking that client's agents and terminals down with the mirror.
   * Video is lossy under pressure: a stale frame is correct, a dead socket is not.
   */
  private readonly deliveries = new WeakMap<BrowserScreencastViewer, BrowserScreencastDelivery>();
  private readonly stopGraceMs: number;

  public constructor(broker: BrowserScreencastBroker, options?: { stopGraceMs?: number }) {
    this.broker = broker;
    this.stopGraceMs = options?.stopGraceMs ?? SCREENCAST_STOP_GRACE_MS;
  }

  public async subscribe(params: {
    viewer: BrowserScreencastViewer;
    browserId: string;
    workspaceId?: string;
    maxWidth?: number;
    maxHeight?: number;
  }): Promise<BrowserScreencastSubscription> {
    // Every other browser command is scoped to a workspace. A viewer that
    // declares one must not reach a tab outside it, including by joining a
    // stream a viewer in another workspace already started.
    const tabWorkspaceId = this.broker.getBrowserWorkspaceId(params.browserId);
    if (params.workspaceId && tabWorkspaceId && tabWorkspaceId !== params.workspaceId) {
      return {
        ok: false,
        error: `Browser tab ${params.browserId} is not in workspace ${params.workspaceId}.`,
      };
    }

    const size = clampScreencastSize({
      maxWidth: params.maxWidth ?? DEFAULT_SCREENCAST_SIZE.maxWidth,
      maxHeight: params.maxHeight ?? DEFAULT_SCREENCAST_SIZE.maxHeight,
    });
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

    // A stop still in flight holds its slot, and this browser is the one caller
    // that may take it back: a stale frame from its own capture is its own tab.
    const pendingStop = this.stopping.get(params.browserId);
    const slot = pendingStop?.slot ?? this.allocateSlot();
    if (slot === null) {
      return { ok: false, error: "All browser screencast slots are in use." };
    }

    const started = afterSettled(pendingStop?.settled, () =>
      this.start({
        browserId: params.browserId,
        slot,
        size,
        ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
      }),
    );
    const stream: BrowserScreencastStream = {
      browserId: params.browserId,
      slot,
      // The host that last claimed this tab, until the start settles which one
      // is capturing. A frame that beats that response is dropped by the viewer
      // anyway: it has not mapped the slot yet.
      hostClientId: this.broker.getBrowserHostClientId(params.browserId),
      workspaceId: params.workspaceId,
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
    stream.hostClientId = this.broker.getBrowserHostClientId(params.browserId);
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
    const stop: BrowserScreencastStop = {
      settled: afterSettled(stream.started, () =>
        this.broker.execute({
          command: { command: "screencast_stop", args: { browserId: params.browserId } },
        }),
      ),
      slot: stream.slot,
    };
    this.stopping.set(params.browserId, stop);
    this.release(stream);
    try {
      await stop.settled;
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

  /**
   * Frames are routed by slot alone, so without the owner check any session
   * could push frames into a browser it does not host.
   */
  public handleFrame(params: { frame: BrowserScreencastFrame; sourceClientId: string }): void {
    const stream = this.streamsBySlot.get(params.frame.slot);
    if (!stream || stream.hostClientId !== params.sourceClientId) {
      return;
    }
    const bytes = encodeBrowserScreencastFrame(params.frame);
    stream.lastFrame = bytes;
    for (const viewer of stream.viewers.keys()) {
      this.deliver(viewer, bytes);
    }
  }

  private deliver(viewer: BrowserScreencastViewer, frame: Uint8Array): void {
    const delivery = this.deliveries.get(viewer);
    if (delivery) {
      delivery.pending = frame;
      return;
    }
    const started: BrowserScreencastDelivery = { pending: null };
    this.deliveries.set(viewer, started);
    void this.drain(viewer, started, frame);
  }

  private async drain(
    viewer: BrowserScreencastViewer,
    delivery: BrowserScreencastDelivery,
    first: Uint8Array,
  ): Promise<void> {
    let next: Uint8Array | null = first;
    while (next) {
      try {
        await viewer.sendFrame(next);
      } catch {
        // The viewer's transport is gone or being torn down, and the frames it
        // did not take are worthless either way.
        break;
      }
      next = delivery.pending;
      delivery.pending = null;
    }
    this.deliveries.delete(viewer);
  }

  private start(params: {
    browserId: string;
    slot: number;
    size: BrowserScreencastSize;
    workspaceId?: string;
  }): Promise<BrowserToolsResponsePayload> {
    return this.broker.execute({
      ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
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
      this.start({
        browserId: stream.browserId,
        slot: stream.slot,
        size,
        ...(stream.workspaceId ? { workspaceId: stream.workspaceId } : {}),
      }),
    );
  }

  private allocateSlot(): number | null {
    const stopping = new Set<number>();
    for (const stop of this.stopping.values()) {
      stopping.add(stop.slot);
    }
    for (let slot = 0; slot < SCREENCAST_SLOT_COUNT; slot += 1) {
      if (!this.streamsBySlot.has(slot) && !stopping.has(slot)) {
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
  // Two viewers that each fit the budget can still describe a box that does not.
  return clampScreencastSize({ maxWidth, maxHeight });
}

/** Both axes bound the box the host fits the tab into, so clamping cannot distort it. */
function clampScreencastSize(size: BrowserScreencastSize): BrowserScreencastSize {
  const maxWidth = Math.min(size.maxWidth, MAX_SCREENCAST_DIMENSION);
  const maxHeight = Math.min(size.maxHeight, MAX_SCREENCAST_DIMENSION);
  const pixels = maxWidth * maxHeight;
  if (pixels <= MAX_SCREENCAST_PIXELS) {
    return { maxWidth, maxHeight };
  }
  const scale = Math.sqrt(MAX_SCREENCAST_PIXELS / pixels);
  return {
    maxWidth: Math.max(1, Math.floor(maxWidth * scale)),
    maxHeight: Math.max(1, Math.floor(maxHeight * scale)),
  };
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
