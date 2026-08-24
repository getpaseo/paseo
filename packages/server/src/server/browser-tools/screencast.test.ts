import { describe, expect, test } from "vitest";
import { encodeBrowserScreencastFrame } from "@getpaseo/protocol/binary-frames/screencast";
import type { BrowserAutomationCommand } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import type { BrowserToolsExecuteInput } from "./broker.js";
import type { BrowserToolsResponsePayload } from "./errors.js";
import { browserToolsFailure } from "./errors.js";
import { BrowserScreencastRegistry, type BrowserScreencastViewer } from "./screencast.js";

const BROWSER_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_BROWSER_ID = "22222222-2222-4222-8222-222222222222";
const THIRD_BROWSER_ID = "33333333-3333-4333-8333-333333333333";
const HOST_CLIENT_ID = "browser-host-1";

class FakeBroker {
  public readonly commands: BrowserAutomationCommand[] = [];
  public failure: string | null = null;
  public hostClientId: string | null = HOST_CLIENT_ID;
  public workspaceId: string | null = null;
  private readonly latencyMs: number;

  public constructor(options?: { latencyMs?: number }) {
    this.latencyMs = options?.latencyMs ?? 0;
  }

  public getBrowserHostClientId(): string | null {
    return this.hostClientId;
  }

  public getBrowserWorkspaceId(): string | null {
    return this.workspaceId;
  }

  public async execute(input: BrowserToolsExecuteInput): Promise<BrowserToolsResponsePayload> {
    // Recorded on the way out: the order here is the order the host sees.
    this.commands.push(input.command);
    if (this.latencyMs > 0) {
      await delay(this.latencyMs);
    }
    if (this.failure) {
      return browserToolsFailure({
        requestId: "req-1",
        code: "browser_no_host",
        message: this.failure,
      });
    }
    return { requestId: "req-1", ok: true, result: screencastResult(input.command) };
  }

  public commandNames(): string[] {
    return this.commands.map((command) => command.command);
  }
}

function screencastResult(
  command: BrowserAutomationCommand,
): Extract<BrowserToolsResponsePayload, { ok: true }>["result"] {
  if (command.command === "screencast_start") {
    return {
      command: "screencast_start",
      browserId: command.args.browserId,
      slot: command.args.slot,
    };
  }
  if (command.command === "screencast_stop") {
    return { command: "screencast_stop", browserId: command.args.browserId };
  }
  throw new Error(`Unexpected command ${command.command}`);
}

function startCommand(size: { maxWidth: number; maxHeight: number }, slot = 0) {
  return {
    command: "screencast_start",
    args: { browserId: BROWSER_ID, slot, quality: 90, ...size, everyNthFrame: 1 },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createViewer(): BrowserScreencastViewer & { frames: Uint8Array[] } {
  const frames: Uint8Array[] = [];
  return {
    frames,
    sendFrame: async (frame) => {
      frames.push(frame);
    },
  };
}

interface StalledViewer extends BrowserScreencastViewer {
  frames: Uint8Array[];
  /** Sends handed to the transport that have not completed. */
  inFlight: () => number;
  settle: () => void;
}

/** A viewer whose transport only completes a send when the test says so. */
function createStalledViewer(): StalledViewer {
  const frames: Uint8Array[] = [];
  let pendingSends: Array<() => void> = [];
  return {
    frames,
    inFlight: () => pendingSends.length,
    settle: () => {
      const settling = pendingSends;
      pendingSends = [];
      for (const complete of settling) {
        complete();
      }
    },
    sendFrame: (frame) => {
      frames.push(frame);
      return new Promise<void>((resolve) => {
        pendingSends.push(resolve);
      });
    },
  };
}

function encodedFrame(payload: string, slot = 0): Uint8Array {
  return encodeBrowserScreencastFrame({
    slot,
    metadata: { deviceWidth: 1280, deviceHeight: 800 },
    payload: new TextEncoder().encode(payload),
  });
}

/** Lets the delivery loop run every microtask it has queued. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function jpegFrame(slot: number, payload: string) {
  return {
    opcode: 0x20 as const,
    slot,
    metadata: { deviceWidth: 1280, deviceHeight: 800 },
    payload: new TextEncoder().encode(payload),
  };
}

describe("BrowserScreencastRegistry", () => {
  test("starts the host once and shares one slot across viewers", async () => {
    const broker = new FakeBroker();
    const registry = new BrowserScreencastRegistry(broker, { stopGraceMs: 0 });
    const first = createViewer();
    const second = createViewer();

    const firstSubscription = await registry.subscribe({ viewer: first, browserId: BROWSER_ID });
    const secondSubscription = await registry.subscribe({ viewer: second, browserId: BROWSER_ID });

    expect(firstSubscription).toEqual({ ok: true, slot: 0, replay: null });
    expect(secondSubscription).toEqual({ ok: true, slot: 0, replay: null });
    expect(broker.commands).toEqual([startCommand({ maxWidth: 2560, maxHeight: 1600 })]);
  });

  test("runs the stream at the largest size across viewers", async () => {
    const broker = new FakeBroker();
    const registry = new BrowserScreencastRegistry(broker, { stopGraceMs: 0 });
    const phone = createViewer();
    const desktop = createViewer();

    await registry.subscribe({
      viewer: phone,
      browserId: BROWSER_ID,
      maxWidth: 960,
      maxHeight: 1920,
    });
    await registry.subscribe({
      viewer: desktop,
      browserId: BROWSER_ID,
      maxWidth: 3840,
      maxHeight: 1280,
    });

    // Width and height climb independently: the box has to cover both panes.
    expect(broker.commands).toEqual([
      startCommand({ maxWidth: 960, maxHeight: 1920 }),
      startCommand({ maxWidth: 3840, maxHeight: 1920 }),
    ]);
  });

  test("keeps the stream as it is when a smaller viewer joins", async () => {
    const broker = new FakeBroker();
    const registry = new BrowserScreencastRegistry(broker, { stopGraceMs: 0 });
    const large = createViewer();
    const small = createViewer();

    await registry.subscribe({
      viewer: large,
      browserId: BROWSER_ID,
      maxWidth: 3840,
      maxHeight: 2160,
    });
    await registry.subscribe({
      viewer: small,
      browserId: BROWSER_ID,
      maxWidth: 640,
      maxHeight: 480,
    });

    // Re-arming costs a visible frame, and the small viewer is already covered.
    expect(broker.commands).toEqual([startCommand({ maxWidth: 3840, maxHeight: 2160 })]);
  });

  test("shrinks the stream when the largest viewer leaves", async () => {
    const broker = new FakeBroker();
    const registry = new BrowserScreencastRegistry(broker, { stopGraceMs: 0 });
    const large = createViewer();
    const small = createViewer();
    await registry.subscribe({
      viewer: large,
      browserId: BROWSER_ID,
      maxWidth: 3840,
      maxHeight: 2160,
    });
    await registry.subscribe({
      viewer: small,
      browserId: BROWSER_ID,
      maxWidth: 640,
      maxHeight: 480,
    });

    await registry.unsubscribe({ viewer: large, browserId: BROWSER_ID });

    expect(broker.commands).toEqual([
      startCommand({ maxWidth: 3840, maxHeight: 2160 }),
      startCommand({ maxWidth: 640, maxHeight: 480 }),
    ]);
  });

  test("a viewer that declares no size holds the stream at the default", async () => {
    const broker = new FakeBroker();
    const registry = new BrowserScreencastRegistry(broker, { stopGraceMs: 0 });
    const declaring = createViewer();
    const silent = createViewer();

    await registry.subscribe({ viewer: declaring, browserId: BROWSER_ID, maxWidth: 640 });
    await registry.subscribe({ viewer: silent, browserId: BROWSER_ID });

    // An app old enough to send no size still gets what it always got.
    expect(broker.commands).toEqual([
      startCommand({ maxWidth: 640, maxHeight: 1600 }),
      startCommand({ maxWidth: 2560, maxHeight: 1600 }),
    ]);

    await registry.unsubscribe({ viewer: declaring, browserId: BROWSER_ID });
    expect(broker.commands).toHaveLength(2);
  });

  test("re-subscribing resizes the running stream on the same slot", async () => {
    const broker = new FakeBroker();
    const registry = new BrowserScreencastRegistry(broker, { stopGraceMs: 0 });
    const viewer = createViewer();
    await registry.subscribe({
      viewer,
      browserId: BROWSER_ID,
      maxWidth: 1280,
      maxHeight: 800,
    });
    registry.handleFrame({ frame: jpegFrame(0, "jpeg-bytes"), sourceClientId: HOST_CLIENT_ID });

    const resized = await registry.subscribe({
      viewer,
      browserId: BROWSER_ID,
      maxWidth: 1600,
      maxHeight: 800,
    });

    // Replayed even though the viewer already shows it: one repeated decode is
    // cheaper than telling apart a resize from a remount, and the re-armed
    // stream's first frame supersedes it.
    expect(resized).toEqual({ ok: true, slot: 0, replay: viewer.frames[0] });
    expect(broker.commands).toEqual([
      startCommand({ maxWidth: 1280, maxHeight: 800 }),
      startCommand({ maxWidth: 1600, maxHeight: 800 }),
    ]);
    expect(broker.commandNames()).not.toContain("screencast_stop");
  });

  test("stops the host only once the last viewer unsubscribes", async () => {
    const broker = new FakeBroker();
    const registry = new BrowserScreencastRegistry(broker, { stopGraceMs: 0 });
    const first = createViewer();
    const second = createViewer();
    await registry.subscribe({ viewer: first, browserId: BROWSER_ID });
    await registry.subscribe({ viewer: second, browserId: BROWSER_ID });

    await registry.unsubscribe({ viewer: first, browserId: BROWSER_ID });
    expect(broker.commandNames()).toEqual(["screencast_start"]);

    await registry.unsubscribe({ viewer: second, browserId: BROWSER_ID });
    expect(broker.commands.at(-1)).toEqual({
      command: "screencast_stop",
      args: { browserId: BROWSER_ID },
    });
  });

  test("releases the slot for reuse once a stream ends", async () => {
    const broker = new FakeBroker();
    const registry = new BrowserScreencastRegistry(broker, { stopGraceMs: 0 });
    const viewer = createViewer();

    const first = await registry.subscribe({ viewer, browserId: BROWSER_ID });
    const second = await registry.subscribe({ viewer, browserId: SECOND_BROWSER_ID });
    expect(first).toEqual({ ok: true, slot: 0, replay: null });
    expect(second).toEqual({ ok: true, slot: 1, replay: null });

    await registry.unsubscribe({ viewer, browserId: BROWSER_ID });
    const reused = await registry.subscribe({ viewer, browserId: BROWSER_ID });
    expect(reused).toEqual({ ok: true, slot: 0, replay: null });
  });

  test("holds a slot until the host has answered the stop for it", async () => {
    const broker = new FakeBroker({ latencyMs: 40 });
    const registry = new BrowserScreencastRegistry(broker, { stopGraceMs: 0 });
    const leaving = createViewer();
    const arriving = createViewer();
    await registry.subscribe({ viewer: leaving, browserId: BROWSER_ID });

    const teardown = registry.unsubscribe({ viewer: leaving, browserId: BROWSER_ID });
    // Past the grace, so the stop is committed, and inside the host round trip,
    // so the old capture is still running on the slot.
    await delay(10);
    const next = await registry.subscribe({ viewer: arriving, browserId: SECOND_BROWSER_ID });

    expect(next).toMatchObject({ ok: true, slot: 1 });
    // Both tabs are hosted by the same client, so a frame from the capture that
    // has not stopped yet passes the owner check and would paint the new pane.
    registry.handleFrame({ frame: jpegFrame(0, "stale"), sourceClientId: HOST_CLIENT_ID });
    expect(arriving.frames).toEqual([]);

    await teardown;
    // Reserved until the stop settles, not withheld for good.
    const third = await registry.subscribe({ viewer: arriving, browserId: THIRD_BROWSER_ID });
    expect(third).toMatchObject({ ok: true, slot: 0 });
  });

  test("fans frames out to every viewer on the slot", async () => {
    const broker = new FakeBroker();
    const registry = new BrowserScreencastRegistry(broker, { stopGraceMs: 0 });
    const first = createViewer();
    const second = createViewer();
    await registry.subscribe({ viewer: first, browserId: BROWSER_ID });
    await registry.subscribe({ viewer: second, browserId: BROWSER_ID });

    registry.handleFrame({ frame: jpegFrame(0, "jpeg-bytes"), sourceClientId: HOST_CLIENT_ID });
    registry.handleFrame({ frame: jpegFrame(7, "other-stream"), sourceClientId: HOST_CLIENT_ID });

    const expected = encodeBrowserScreencastFrame({
      slot: 0,
      metadata: { deviceWidth: 1280, deviceHeight: 800 },
      payload: new TextEncoder().encode("jpeg-bytes"),
    });
    expect(first.frames).toEqual([expected]);
    expect(second.frames).toEqual([expected]);
  });

  test("dropping a viewer stops every stream it was alone on", async () => {
    const broker = new FakeBroker();
    const registry = new BrowserScreencastRegistry(broker, { stopGraceMs: 0 });
    const leaving = createViewer();
    const staying = createViewer();
    await registry.subscribe({ viewer: leaving, browserId: BROWSER_ID });
    await registry.subscribe({ viewer: staying, browserId: BROWSER_ID });
    await registry.subscribe({ viewer: leaving, browserId: SECOND_BROWSER_ID });

    await registry.removeViewer(leaving);

    expect(broker.commands.filter((command) => command.command === "screencast_stop")).toEqual([
      { command: "screencast_stop", args: { browserId: SECOND_BROWSER_ID } },
    ]);

    registry.handleFrame({ frame: jpegFrame(0, "jpeg-bytes"), sourceClientId: HOST_CLIENT_ID });
    expect(leaving.frames).toEqual([]);
    expect(staying.frames).toHaveLength(1);
  });

  test("a failed host start releases the slot and reports the broker error", async () => {
    const broker = new FakeBroker();
    broker.failure = "The app hosting the tab disconnected.";
    const registry = new BrowserScreencastRegistry(broker, { stopGraceMs: 0 });
    const viewer = createViewer();

    const subscription = await registry.subscribe({ viewer, browserId: BROWSER_ID });
    expect(subscription).toEqual({ ok: false, error: "The app hosting the tab disconnected." });

    broker.failure = null;
    await expect(registry.subscribe({ viewer, browserId: BROWSER_ID })).resolves.toEqual({
      ok: true,
      slot: 0,
      replay: null,
    });
  });

  test("subscribing fails cleanly when every slot is taken", async () => {
    const broker = new FakeBroker();
    const registry = new BrowserScreencastRegistry(broker, { stopGraceMs: 0 });
    const viewer = createViewer();
    for (let index = 0; index < 256; index += 1) {
      const browserId = `${1_700_000_000_000 + index}-abcdef`;
      await registry.subscribe({ viewer, browserId });
    }

    await expect(registry.subscribe({ viewer, browserId: BROWSER_ID })).resolves.toEqual({
      ok: false,
      error: "All browser screencast slots are in use.",
    });
  });

  test("a viewer that returns within the grace rejoins the running capture", async () => {
    const broker = new FakeBroker();
    const registry = new BrowserScreencastRegistry(broker, { stopGraceMs: 20 });
    const viewer = createViewer();
    await registry.subscribe({ viewer, browserId: BROWSER_ID });

    // A pane that remounts unsubscribes and subscribes again immediately.
    const teardown = registry.unsubscribe({ viewer, browserId: BROWSER_ID });
    const resubscribed = await registry.subscribe({ viewer, browserId: BROWSER_ID });
    await teardown;

    expect(resubscribed).toMatchObject({ ok: true, slot: 0 });
    // Neither stopped nor re-armed: the host never noticed the remount.
    expect(broker.commandNames()).toEqual(["screencast_start"]);

    registry.handleFrame({ frame: jpegFrame(0, "jpeg-bytes"), sourceClientId: HOST_CLIENT_ID });
    expect(viewer.frames).toHaveLength(1);
  });

  test("replays the last frame to a viewer that joins an existing stream", async () => {
    const broker = new FakeBroker();
    const registry = new BrowserScreencastRegistry(broker, { stopGraceMs: 0 });
    const first = createViewer();
    await registry.subscribe({ viewer: first, browserId: BROWSER_ID });

    registry.handleFrame({ frame: jpegFrame(0, "hello"), sourceClientId: HOST_CLIENT_ID });
    expect(first.frames).toHaveLength(1);

    // Chrome only emits on damage, so a static page leaves a late viewer blank.
    const late = createViewer();
    const subscription = await registry.subscribe({ viewer: late, browserId: BROWSER_ID });

    // Returned rather than pushed: the caller sends it after the subscribe
    // response, otherwise it lands before the viewer has mapped the slot.
    expect(subscription).toEqual({ ok: true, slot: 0, replay: first.frames[0] });
    expect(late.frames).toHaveLength(0);
  });

  test("replays to a viewer that is already on the stream", async () => {
    const broker = new FakeBroker();
    const registry = new BrowserScreencastRegistry(broker, { stopGraceMs: 0 });
    const viewer = createViewer();
    await registry.subscribe({ viewer, browserId: BROWSER_ID });
    registry.handleFrame({ frame: jpegFrame(0, "jpeg-bytes"), sourceClientId: HOST_CLIENT_ID });

    // A second pane on the same browser is the same viewer: the daemon keys
    // viewers by socket, and both panes are in one window. The pane has decoded
    // nothing, and a settled page emits nothing further, so without a replay it
    // stays blank until something repaints the guest.
    const secondPane = await registry.subscribe({ viewer, browserId: BROWSER_ID });

    expect(secondPane).toEqual({ ok: true, slot: 0, replay: viewer.frames[0] });
    expect(broker.commandNames()).toEqual(["screencast_start"]);
  });

  test("a start issued while a stop is in flight reaches the host after it", async () => {
    const broker = new FakeBroker({ latencyMs: 40 });
    const registry = new BrowserScreencastRegistry(broker, { stopGraceMs: 0 });
    const viewer = createViewer();
    await registry.subscribe({ viewer, browserId: BROWSER_ID, maxWidth: 1280, maxHeight: 800 });
    // A resize leaves a start in flight that the stop has to wait out.
    void registry.subscribe({ viewer, browserId: BROWSER_ID, maxWidth: 1600, maxHeight: 800 });

    const teardown = registry.unsubscribe({ viewer, browserId: BROWSER_ID });
    // Past the grace, so the stop is committed, and inside the host round trip,
    // so it has not landed: the window where a fresh subscribe overtakes it.
    await delay(10);
    const resubscribed = await registry.subscribe({ viewer, browserId: BROWSER_ID });
    await teardown;

    expect(resubscribed).toMatchObject({ ok: true, slot: 0 });
    // The host's last command matches what the registry believes: a live stream.
    expect(broker.commandNames()).toEqual([
      "screencast_start",
      "screencast_start",
      "screencast_stop",
      "screencast_start",
    ]);
  });

  test("holds one frame per viewer under pressure instead of queueing them", async () => {
    const broker = new FakeBroker();
    const registry = new BrowserScreencastRegistry(broker, { stopGraceMs: 0 });
    const viewer = createStalledViewer();
    await registry.subscribe({ viewer, browserId: BROWSER_ID });

    for (let index = 0; index < 50; index += 1) {
      registry.handleFrame({
        frame: jpegFrame(0, `frame-${index}`),
        sourceClientId: HOST_CLIENT_ID,
      });
    }

    // Queueing 50 frames onto a stalled socket is what pushes it past the
    // outbound high-water mark, and crossing that terminates the socket along
    // with the client's agents and terminals. One frame is on the wire.
    expect(viewer.inFlight()).toBe(1);

    viewer.settle();
    await flush();
    // The newest frame took the waiting slot from every frame before it.
    expect(viewer.inFlight()).toBe(1);
    viewer.settle();
    await flush();

    expect(viewer.frames).toEqual([encodedFrame("frame-0"), encodedFrame("frame-49")]);
  });

  test("resumes delivery once a stalled viewer drains", async () => {
    const broker = new FakeBroker();
    const registry = new BrowserScreencastRegistry(broker, { stopGraceMs: 0 });
    const viewer = createStalledViewer();
    await registry.subscribe({ viewer, browserId: BROWSER_ID });

    registry.handleFrame({ frame: jpegFrame(0, "first"), sourceClientId: HOST_CLIENT_ID });
    viewer.settle();
    await flush();
    registry.handleFrame({ frame: jpegFrame(0, "second"), sourceClientId: HOST_CLIENT_ID });

    expect(viewer.frames).toEqual([encodedFrame("first"), encodedFrame("second")]);
  });

  test("clamps a subscribe past the daemon's encode budget", async () => {
    const broker = new FakeBroker();
    const registry = new BrowserScreencastRegistry(broker, { stopGraceMs: 0 });
    const viewer = createViewer();

    await registry.subscribe({
      viewer,
      browserId: BROWSER_ID,
      maxWidth: 100_000,
      maxHeight: 100_000,
    });

    // 4096 per axis, then scaled down to the daemon's 3840x2160 pixel budget.
    expect(broker.commands).toEqual([startCommand({ maxWidth: 2880, maxHeight: 2880 })]);
  });

  test("clamps the combined size two viewers ask the host for", async () => {
    const broker = new FakeBroker();
    const registry = new BrowserScreencastRegistry(broker, { stopGraceMs: 0 });
    const wide = createViewer();
    const tall = createViewer();

    await registry.subscribe({ viewer: wide, browserId: BROWSER_ID, maxWidth: 4096, maxHeight: 8 });
    await registry.subscribe({ viewer: tall, browserId: BROWSER_ID, maxWidth: 8, maxHeight: 4096 });

    // Each viewer is inside the budget on its own; the box that covers both is not.
    expect(broker.commands.at(-1)).toEqual(startCommand({ maxWidth: 2880, maxHeight: 2880 }));
  });

  test("drops a frame pushed by a session that does not host the stream", async () => {
    const broker = new FakeBroker();
    const registry = new BrowserScreencastRegistry(broker, { stopGraceMs: 0 });
    const viewer = createViewer();
    await registry.subscribe({ viewer, browserId: BROWSER_ID });

    registry.handleFrame({ frame: jpegFrame(0, "forged"), sourceClientId: "another-client" });
    expect(viewer.frames).toEqual([]);

    registry.handleFrame({ frame: jpegFrame(0, "genuine"), sourceClientId: HOST_CLIENT_ID });
    expect(viewer.frames).toEqual([encodedFrame("genuine")]);
  });

  test("refuses a subscribe for a browser outside the requested workspace", async () => {
    const broker = new FakeBroker();
    broker.workspaceId = "workspace-1";
    const registry = new BrowserScreencastRegistry(broker, { stopGraceMs: 0 });
    const viewer = createViewer();

    const subscription = await registry.subscribe({
      viewer,
      browserId: BROWSER_ID,
      workspaceId: "workspace-2",
    });

    expect(subscription).toEqual({
      ok: false,
      error: `Browser tab ${BROWSER_ID} is not in workspace workspace-2.`,
    });
    expect(broker.commands).toEqual([]);
  });

  test("refuses a viewer joining a running stream from another workspace", async () => {
    const broker = new FakeBroker();
    broker.workspaceId = "workspace-1";
    const registry = new BrowserScreencastRegistry(broker, { stopGraceMs: 0 });
    const owner = createViewer();
    const intruder = createViewer();
    await registry.subscribe({ viewer: owner, browserId: BROWSER_ID, workspaceId: "workspace-1" });

    const subscription = await registry.subscribe({
      viewer: intruder,
      browserId: BROWSER_ID,
      workspaceId: "workspace-2",
    });

    expect(subscription).toMatchObject({ ok: false });
    registry.handleFrame({ frame: jpegFrame(0, "jpeg-bytes"), sourceClientId: HOST_CLIENT_ID });
    expect(intruder.frames).toEqual([]);
  });
});
