import { describe, expect, it } from "vitest";
import {
  BrowserScreencastController,
  EMPTY_SCREENCAST_VIEW,
  type BrowserScreencastClient,
  type BrowserScreencastControllerOptions,
  type BrowserScreencastView,
  type ScreencastConnectionStatus,
  type ScreencastFrameEvent,
  type ScreencastFrameSource,
  type ScreencastSizeRequest,
  type ScreencastSubscribeResult,
} from "./screencast-controller";

const BROWSER_ID = "11111111-1111-4111-8111-111111111111";

/**
 * Every lifecycle bug in this pane has been "how many times did that subscribe?",
 * so the fake counts calls rather than modelling the daemon.
 */
class FakeScreencastClient implements BrowserScreencastClient {
  public subscribes: Array<{ browserId: string; options: ScreencastSizeRequest }> = [];
  public unsubscribes: string[] = [];
  public nextSubscribeResult: ScreencastSubscribeResult = { error: null };
  private frameHandlers = new Set<(event: ScreencastFrameEvent) => void>();
  private connectionListeners = new Set<(status: ScreencastConnectionStatus) => void>();

  async subscribeBrowserScreencast(
    browserId: string,
    options: ScreencastSizeRequest,
  ): Promise<ScreencastSubscribeResult> {
    this.subscribes.push({ browserId, options });
    return this.nextSubscribeResult;
  }

  unsubscribeBrowserScreencast(browserId: string): void {
    this.unsubscribes.push(browserId);
  }

  onBrowserScreencastFrame(handler: (event: ScreencastFrameEvent) => void): () => void {
    this.frameHandlers.add(handler);
    return () => {
      this.frameHandlers.delete(handler);
    };
  }

  subscribeConnectionStatus(listener: (status: ScreencastConnectionStatus) => void): () => void {
    this.connectionListeners.add(listener);
    // The real client replays the current status the moment you subscribe.
    listener({ status: "connected" });
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  emitConnection(status: string): void {
    for (const listener of this.connectionListeners) {
      listener({ status });
    }
  }

  emitFrame(event: ScreencastFrameEvent): void {
    for (const handler of this.frameHandlers) {
      handler(event);
    }
  }

  get requestedSizes(): ScreencastSizeRequest[] {
    return this.subscribes.map((call) => call.options);
  }
}

interface MountedController {
  client: FakeScreencastClient;
  controller: BrowserScreencastController;
  views: BrowserScreencastView[];
  released: string[];
}

function startController(
  overrides: Partial<Pick<BrowserScreencastControllerOptions, "getPixelRatio">> = {},
): MountedController {
  const client = new FakeScreencastClient();
  const views: BrowserScreencastView[] = [];
  const released: string[] = [];
  let frameCount = 0;
  const controller = new BrowserScreencastController({
    client,
    browserId: BROWSER_ID,
    getPixelRatio: overrides.getPixelRatio ?? (() => 1),
    createFrameSource: (data: Uint8Array): ScreencastFrameSource => {
      frameCount += 1;
      const uri = `frame-${String(frameCount)}-${String(data.length)}`;
      return { uri, release: () => released.push(uri) };
    },
    onView: (view) => views.push(view),
  });
  return { client, controller, views, released };
}

function frame(input: { data: Uint8Array; browserId?: string }): ScreencastFrameEvent {
  return {
    browserId: input.browserId ?? BROWSER_ID,
    metadata: { deviceWidth: 800, deviceHeight: 600 },
    data: input.data,
  };
}

/** Lets an already-resolved `subscribeBrowserScreencast` deliver its answer. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("BrowserScreencastController subscriptions", () => {
  it("does not subscribe before the pane has been laid out", async () => {
    const { client, controller } = startController();

    controller.setPaneSize(null);
    await settle();

    expect(client.subscribes).toEqual([]);
  });

  it("does not subscribe for a pane that laid out at zero", async () => {
    const { client, controller } = startController();

    controller.setPaneSize({ width: 0, height: 0 });
    await settle();

    expect(client.subscribes).toEqual([]);
  });

  it("subscribes once for a pane that reports its size", async () => {
    const { client, controller } = startController();

    controller.setPaneSize({ width: 1000, height: 800 });
    await settle();

    // A client that replays "connected" on subscribe must not look like a
    // reconnect, or every mount re-arms the host capture for nothing.
    expect(client.subscribes).toEqual([
      { browserId: BROWSER_ID, options: { maxWidth: 960, maxHeight: 960 } },
    ]);
  });

  it("ignores a resize that lands inside the same quantised step", async () => {
    const { client, controller } = startController();
    controller.setPaneSize({ width: 1000, height: 800 });
    await settle();

    controller.setPaneSize({ width: 1004, height: 803 });
    await settle();

    expect(client.subscribes).toHaveLength(1);
  });

  it("re-subscribes once when a resize crosses a step", async () => {
    const { client, controller } = startController();
    controller.setPaneSize({ width: 400, height: 400 });
    await settle();

    controller.setPaneSize({ width: 1600, height: 1200 });
    await settle();

    expect(client.requestedSizes).toEqual([
      { maxWidth: 320, maxHeight: 320 },
      { maxWidth: 1600, maxHeight: 1280 },
    ]);
  });

  it("caps a retina pane at the host's pixel budget instead of asking for every device pixel", async () => {
    const { client, controller } = startController({ getPixelRatio: () => 2 });

    controller.setPaneSize({ width: 2000, height: 1500 });
    await settle();

    // 2000x1500 at ratio 2 is 12M device pixels; the request keeps the aspect
    // ratio and stays under the 4M budget the host encodes per frame.
    expect(client.requestedSizes).toEqual([{ maxWidth: 2240, maxHeight: 1600 }]);
    expect(2240 * 1600).toBeLessThanOrEqual(4_000_000);
  });

  it("re-subscribes when the socket reconnects, because the daemon forgot the stream", async () => {
    const { client, controller } = startController();
    controller.setPaneSize({ width: 1000, height: 800 });
    await settle();

    client.emitConnection("disconnected");
    client.emitConnection("connected");
    await settle();

    expect(client.requestedSizes).toEqual([
      { maxWidth: 960, maxHeight: 960 },
      { maxWidth: 960, maxHeight: 960 },
    ]);
  });

  it("does not re-subscribe while the socket stays connected", async () => {
    const { client, controller } = startController();
    controller.setPaneSize({ width: 1000, height: 800 });
    await settle();

    client.emitConnection("connected");
    client.emitConnection("connected");
    await settle();

    expect(client.subscribes).toHaveLength(1);
  });

  it("does not subscribe on a reconnect the pane never sized", async () => {
    const { client } = startController();

    client.emitConnection("disconnected");
    client.emitConnection("connected");
    await settle();

    expect(client.subscribes).toEqual([]);
  });

  it("reports the host's refusal to the pane", async () => {
    const { client, controller, views } = startController();
    client.nextSubscribeResult = { error: "Browser not found" };

    controller.setPaneSize({ width: 1000, height: 800 });
    await settle();

    expect(views).toEqual([{ ...EMPTY_SCREENCAST_VIEW, error: "Browser not found" }]);
  });

  it("drops the stream and clears the pane when disposed", () => {
    const { client, controller, views } = startController();

    controller.dispose();

    expect(client.unsubscribes).toEqual([BROWSER_ID]);
    expect(views).toEqual([EMPTY_SCREENCAST_VIEW]);
  });

  it("ignores a pane size that arrives after dispose", async () => {
    const { client, controller } = startController();

    controller.dispose();
    controller.setPaneSize({ width: 1000, height: 800 });
    await settle();

    expect(client.subscribes).toEqual([]);
  });
});

describe("BrowserScreencastController visibility", () => {
  it("stops streaming and releases its frames when the pane leaves the screen", async () => {
    const { client, controller, released, views } = startController();
    controller.setPaneSize({ width: 800, height: 600 });
    await settle();
    client.emitFrame(frame({ data: new Uint8Array([1]) }));
    expect(client.subscribes).toHaveLength(1);

    controller.setVisible(false);
    await settle();

    // A retained pane keeps a quality-90 capture open on the host otherwise.
    expect(client.unsubscribes).toEqual([BROWSER_ID]);
    expect(released).toHaveLength(1);
    expect(views.at(-1)).toEqual(EMPTY_SCREENCAST_VIEW);
  });

  it("resubscribes at the same size when the pane comes back", async () => {
    const { client, controller } = startController();
    controller.setPaneSize({ width: 800, height: 600 });
    await settle();
    const first = client.subscribes[0];

    controller.setVisible(false);
    await settle();
    controller.setVisible(true);
    await settle();

    expect(client.subscribes).toHaveLength(2);
    expect(client.subscribes[1]?.options).toEqual(first?.options);
  });

  it("does not subscribe while hidden, even when the pane resizes", async () => {
    const { client, controller } = startController();
    controller.setPaneSize({ width: 800, height: 600 });
    await settle();
    controller.setVisible(false);
    await settle();

    controller.setPaneSize({ width: 1600, height: 1200 });
    await settle();

    expect(client.subscribes).toHaveLength(1);
  });

  it("ignores a repeated visibility value", async () => {
    const { client, controller } = startController();
    controller.setPaneSize({ width: 800, height: 600 });
    await settle();

    controller.setVisible(true);
    await settle();

    expect(client.subscribes).toHaveLength(1);
    expect(client.unsubscribes).toEqual([]);
  });
});

describe("BrowserScreencastController frames", () => {
  it("shows the newest frame with the dimensions the host captured it at", () => {
    const { client, views } = startController();

    client.emitFrame(frame({ data: new Uint8Array([1, 2, 3]) }));

    expect(views).toEqual([{ uri: "frame-1-3", deviceWidth: 800, deviceHeight: 600, error: null }]);
  });

  it("ignores frames belonging to another browser", () => {
    const { client, views } = startController();

    client.emitFrame(frame({ data: new Uint8Array([1]), browserId: "other-browser" }));

    expect(views).toEqual([]);
  });

  it("keeps the frame behind the displayed one, and releases everything older", () => {
    const { client, released } = startController();

    client.emitFrame(frame({ data: new Uint8Array([1]) }));
    client.emitFrame(frame({ data: new Uint8Array([2, 2]) }));
    client.emitFrame(frame({ data: new Uint8Array([3, 3, 3]) }));

    // Releasing the frame the image is still decoding paints a broken image.
    expect(released).toEqual(["frame-1-1"]);
  });

  it("releases every retained frame on dispose", () => {
    const { client, controller, released } = startController();
    client.emitFrame(frame({ data: new Uint8Array([1]) }));
    client.emitFrame(frame({ data: new Uint8Array([2, 2]) }));

    controller.dispose();

    expect(released).toEqual(["frame-1-1", "frame-2-2"]);
  });

  it("ignores frames that arrive after dispose", () => {
    const { client, controller, views } = startController();

    controller.dispose();
    client.emitFrame(frame({ data: new Uint8Array([1]) }));

    expect(views).toEqual([EMPTY_SCREENCAST_VIEW]);
  });
});
