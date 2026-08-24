import type { PaneSize } from "./viewport";

export interface BrowserScreencastView {
  uri: string | null;
  deviceWidth: number;
  deviceHeight: number;
  error: string | null;
}

export const EMPTY_SCREENCAST_VIEW: BrowserScreencastView = {
  uri: null,
  deviceWidth: 0,
  deviceHeight: 0,
  error: null,
};

/** One decoded frame plus the handle that frees whatever holds its bytes. */
export interface ScreencastFrameSource {
  uri: string;
  release: () => void;
}

export interface ScreencastSizeRequest {
  maxWidth: number;
  maxHeight: number;
}

/** What the daemon needs to answer a subscribe: how big, and for which workspace. */
export interface ScreencastSubscribeRequest extends ScreencastSizeRequest {
  workspaceId?: string;
}

export interface ScreencastFrameEvent {
  browserId: string;
  metadata: { deviceWidth: number; deviceHeight: number };
  data: Uint8Array;
}

export interface ScreencastSubscribeResult {
  error: string | null;
}

export interface ScreencastConnectionStatus {
  status: string;
}

/** The slice of the daemon client a mirrored stream needs, so tests can hand over a fake. */
export interface BrowserScreencastClient {
  subscribeBrowserScreencast(
    browserId: string,
    options: ScreencastSubscribeRequest,
  ): Promise<ScreencastSubscribeResult>;
  unsubscribeBrowserScreencast(browserId: string): void;
  onBrowserScreencastFrame(handler: (event: ScreencastFrameEvent) => void): () => void;
  subscribeConnectionStatus(listener: (status: ScreencastConnectionStatus) => void): () => void;
}

export interface BrowserScreencastControllerOptions {
  client: BrowserScreencastClient;
  browserId: string;
  /** The daemon refuses a browser outside this workspace. */
  workspaceId?: string;
  /** Device pixels per layout pixel, read per size change because the pane may move screens. */
  getPixelRatio: () => number;
  createFrameSource: (data: Uint8Array) => ScreencastFrameSource;
  onView: (view: BrowserScreencastView) => void;
}

// Every distinct size the pane reports re-arms the host capture, so the request
// climbs in steps: a drag across a whole step costs one re-arm, not one a pixel.
const SCREENCAST_SIZE_STEP = 320;

// The host encodes a JPEG of this many pixels per frame and the viewer decodes
// it, which is what a keystroke waits on. A retina pane asks for four times the
// pixels it has, so cap the budget rather than the device ratio.
const SCREENCAST_MAX_PIXELS = 4_000_000;

/** The displayed frame plus the one behind it, which may still be decoding. */
const FRAME_RETENTION = 2;

function quantise(pixels: number): number {
  return Math.max(1, Math.round(pixels / SCREENCAST_SIZE_STEP)) * SCREENCAST_SIZE_STEP;
}

function sameSize(
  left: ScreencastSizeRequest | null,
  right: ScreencastSizeRequest | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.maxWidth === right.maxWidth && left.maxHeight === right.maxHeight;
}

/**
 * The subscription lifecycle of one mirrored stream: what size to ask the host
 * for, when that ask is worth repeating, and how long a frame's bytes stay
 * alive. The pane is the only party that knows how many pixels it can show, so
 * it declares them through `setPaneSize`; nothing is subscribed until it has,
 * because subscribing with a placeholder would re-arm the host immediately.
 */
export class BrowserScreencastController {
  private readonly unsubscribeFrames: () => void;
  private readonly unsubscribeConnection: () => void;
  private frames: ScreencastFrameSource[] = [];
  private requested: ScreencastSizeRequest | null = null;
  private subscribeToken = 0;
  private visible = true;
  private disposed = false;

  constructor(private readonly options: BrowserScreencastControllerOptions) {
    this.unsubscribeFrames = options.client.onBrowserScreencastFrame((event) => {
      this.handleFrame(event);
    });
    // A daemon that restarted has forgotten every stream, and a socket that
    // dropped took the subscription with it, so a reconnect has to re-subscribe
    // or the pane sits on "connecting" until something remounts it. The client
    // replays the current status on subscribe; taking that as a reconnect would
    // make every mount subscribe twice, which re-arms the host.
    let wasConnected: boolean | null = null;
    this.unsubscribeConnection = options.client.subscribeConnectionStatus((status) => {
      const isConnected = status.status === "connected";
      const reconnected = wasConnected === false && isConnected;
      wasConnected = isConnected;
      if (reconnected && this.requested) {
        this.subscribe(this.requested);
      }
    });
  }

  setPaneSize(pane: PaneSize | null): void {
    if (this.disposed) {
      return;
    }
    const next = this.requestedSize(pane);
    if (sameSize(next, this.requested)) {
      return;
    }
    this.requested = next;
    if (next && this.visible) {
      this.subscribe(next);
    }
  }

  /**
   * A pane the deck keeps mounted but off screen would otherwise hold a capture
   * open on the host for pixels nobody sees. Re-subscribing redraws immediately
   * because the daemon replays the last frame.
   */
  setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) {
      return;
    }
    this.visible = visible;
    if (visible) {
      if (this.requested) {
        this.subscribe(this.requested);
      }
      return;
    }
    this.subscribeToken += 1;
    this.options.client.unsubscribeBrowserScreencast(this.options.browserId);
    this.releaseFrames();
    this.options.onView(EMPTY_SCREENCAST_VIEW);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.unsubscribeFrames();
    this.unsubscribeConnection();
    this.options.client.unsubscribeBrowserScreencast(this.options.browserId);
    this.releaseFrames();
    this.options.onView(EMPTY_SCREENCAST_VIEW);
  }

  /**
   * A zero-sized first layout would subscribe at the floor and re-arm the host
   * the moment the real size lands, costing a stop and start per mount.
   */
  private requestedSize(pane: PaneSize | null): ScreencastSizeRequest | null {
    if (pane === null || pane.width <= 0 || pane.height <= 0) {
      return null;
    }
    const ratio = this.options.getPixelRatio();
    let width = pane.width * ratio;
    let height = pane.height * ratio;
    const budget = SCREENCAST_MAX_PIXELS / (width * height);
    if (budget < 1) {
      const scale = Math.sqrt(budget);
      width *= scale;
      height *= scale;
    }
    return { maxWidth: quantise(width), maxHeight: quantise(height) };
  }

  /**
   * Re-subscribing rather than unsubscribing first: the daemon keys viewers by
   * session, so this updates the declared size on the stream already running.
   */
  private subscribe(size: ScreencastSizeRequest): void {
    this.subscribeToken += 1;
    const token = this.subscribeToken;
    void (async () => {
      const payload = await this.options.client.subscribeBrowserScreencast(this.options.browserId, {
        ...size,
        ...(this.options.workspaceId ? { workspaceId: this.options.workspaceId } : {}),
      });
      if (this.disposed || token !== this.subscribeToken) {
        return;
      }
      if (payload.error !== null) {
        this.options.onView({ ...EMPTY_SCREENCAST_VIEW, error: payload.error });
      }
    })();
  }

  private handleFrame(event: ScreencastFrameEvent): void {
    if (this.disposed || event.browserId !== this.options.browserId) {
      return;
    }
    const next = this.options.createFrameSource(event.data);
    // Revoking the source the <img> is still decoding paints a broken image, and
    // the swap is a render behind this callback. Keep one frame of slack.
    this.frames.push(next);
    while (this.frames.length > FRAME_RETENTION) {
      this.frames.shift()?.release();
    }
    this.options.onView({
      uri: next.uri,
      deviceWidth: event.metadata.deviceWidth,
      deviceHeight: event.metadata.deviceHeight,
      error: null,
    });
  }

  private releaseFrames(): void {
    for (const frame of this.frames) {
      frame.release();
    }
    this.frames = [];
  }
}
