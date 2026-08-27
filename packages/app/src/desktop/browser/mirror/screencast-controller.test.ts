import { describe, expect, it } from "vitest";
import {
  BrowserScreencastController,
  EMPTY_SCREENCAST_VIEW,
  type BrowserScreencastClient,
  type BrowserScreencastView,
  type ScreencastConnectionStatus,
  type ScreencastFrameEvent,
  type ScreencastSizeRequest,
  type ScreencastSubscribeResult,
} from "./screencast-controller";

const BROWSER_ID = "11111111-1111-4111-8111-111111111111";

class FakeClient implements BrowserScreencastClient {
  subscribes: ScreencastSizeRequest[] = [];
  unsubscribes: string[] = [];
  result: ScreencastSubscribeResult = { error: null };
  frames = new Set<(event: ScreencastFrameEvent) => void>();
  connections = new Set<(status: ScreencastConnectionStatus) => void>();
  async subscribeBrowserScreencast(_id: string, size: ScreencastSizeRequest) {
    this.subscribes.push(size);
    return this.result;
  }
  unsubscribeBrowserScreencast(id: string) {
    this.unsubscribes.push(id);
  }
  onBrowserScreencastFrame(handler: (event: ScreencastFrameEvent) => void) {
    this.frames.add(handler);
    return () => this.frames.delete(handler);
  }
  subscribeConnectionStatus(handler: (status: ScreencastConnectionStatus) => void) {
    this.connections.add(handler);
    handler({ status: "connected" });
    return () => this.connections.delete(handler);
  }
  emitConnection(status: string) {
    for (const handler of this.connections) handler({ status });
  }
  emitFrame(event: ScreencastFrameEvent) {
    for (const handler of this.frames) handler(event);
  }
}

function setup(pixelRatio = 1) {
  const client = new FakeClient();
  const views: BrowserScreencastView[] = [];
  const released: string[] = [];
  let count = 0;
  const controller = new BrowserScreencastController({
    client,
    browserId: BROWSER_ID,
    getPixelRatio: () => pixelRatio,
    createFrameSource: (data) => {
      const uri = `frame-${String(++count)}-${String(data.length)}`;
      return { uri, release: () => released.push(uri) };
    },
    onView: (view) => views.push(view),
  });
  return { client, controller, views, released };
}

const frame = (length: number, browserId = BROWSER_ID): ScreencastFrameEvent => ({
  browserId,
  metadata: { deviceWidth: 800, deviceHeight: 600 },
  data: new Uint8Array(length),
});
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("BrowserScreencastController", () => {
  it.each([null, { width: 0, height: 0 }])("waits for a usable pane size", async (pane) => {
    const { client, controller } = setup();
    controller.setPaneSize(pane);
    await settle();
    expect(client.subscribes).toEqual([]);
  });

  it("subscribes only when the quantized pane size changes", async () => {
    const { client, controller } = setup();
    controller.setPaneSize({ width: 1000, height: 800 });
    controller.setPaneSize({ width: 1004, height: 803 });
    controller.setPaneSize({ width: 1600, height: 1200 });
    await settle();
    expect(client.subscribes).toEqual([
      { maxWidth: 960, maxHeight: 960 },
      { maxWidth: 1600, maxHeight: 1280 },
    ]);
  });

  it("caps retina requests at the host pixel budget", async () => {
    const { client, controller } = setup(2);
    controller.setPaneSize({ width: 2000, height: 1500 });
    await settle();
    expect(client.subscribes).toEqual([{ maxWidth: 2240, maxHeight: 1600 }]);
  });

  it("resubscribes after reconnect but not repeated connected events", async () => {
    const { client, controller } = setup();
    controller.setPaneSize({ width: 1000, height: 800 });
    client.emitConnection("connected");
    client.emitConnection("connected");
    client.emitConnection("disconnected");
    client.emitConnection("connected");
    await settle();
    expect(client.subscribes).toEqual([
      { maxWidth: 960, maxHeight: 960 },
      { maxWidth: 960, maxHeight: 960 },
    ]);
  });

  it("does not subscribe on reconnect before layout", async () => {
    const { client } = setup();
    client.emitConnection("disconnected");
    client.emitConnection("connected");
    await settle();
    expect(client.subscribes).toEqual([]);
  });

  it("shows a host subscription refusal", async () => {
    const { client, controller, views } = setup();
    client.result = { error: "Browser not found" };
    controller.setPaneSize({ width: 1000, height: 800 });
    await settle();
    expect(views).toEqual([{ ...EMPTY_SCREENCAST_VIEW, error: "Browser not found" }]);
  });

  it("stops hidden streams and resumes at their latest size", async () => {
    const { client, controller, views, released } = setup();
    controller.setPaneSize({ width: 800, height: 600 });
    await settle();
    client.emitFrame(frame(1));
    controller.setVisible(true);
    controller.setVisible(false);
    controller.setPaneSize({ width: 1600, height: 1200 });
    await settle();
    expect(client.unsubscribes).toEqual([BROWSER_ID]);
    expect(released).toEqual(["frame-1-1"]);
    expect(views.at(-1)).toEqual(EMPTY_SCREENCAST_VIEW);
    expect(client.subscribes).toEqual([{ maxWidth: 960, maxHeight: 640 }]);

    controller.setVisible(true);
    await settle();
    expect(client.subscribes).toEqual([
      { maxWidth: 960, maxHeight: 640 },
      { maxWidth: 1600, maxHeight: 1280 },
    ]);
  });

  it("shows matching frames and retains only the newest two", () => {
    const { client, views, released } = setup();
    client.emitFrame(frame(1, "other-browser"));
    client.emitFrame(frame(1));
    client.emitFrame(frame(2));
    client.emitFrame(frame(3));
    expect(views.map((view) => view.uri)).toEqual(["frame-1-1", "frame-2-2", "frame-3-3"]);
    expect(views.at(-1)).toEqual({
      uri: "frame-3-3",
      deviceWidth: 800,
      deviceHeight: 600,
      error: null,
    });
    expect(released).toEqual(["frame-1-1"]);
  });

  it("releases frames and ignores work after dispose", async () => {
    const { client, controller, views, released } = setup();
    client.emitFrame(frame(1));
    client.emitFrame(frame(2));
    controller.dispose();
    controller.setPaneSize({ width: 1000, height: 800 });
    client.emitFrame(frame(3));
    await settle();
    expect(client.unsubscribes).toEqual([BROWSER_ID]);
    expect(client.subscribes).toEqual([]);
    expect(released).toEqual(["frame-1-1", "frame-2-2"]);
    expect(views.at(-1)).toEqual(EMPTY_SCREENCAST_VIEW);
  });
});
