import { describe, expect, test } from "vitest";
import { encodeBrowserScreencastFrame } from "@getpaseo/protocol/binary-frames/screencast";
import type { BrowserAutomationCommand } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import type { BrowserToolsExecuteInput } from "./broker.js";
import type { BrowserToolsResponsePayload } from "./errors.js";
import { browserToolsFailure } from "./errors.js";
import { BrowserScreencastRegistry, type BrowserScreencastViewer } from "./screencast.js";

const BROWSER_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_BROWSER_ID = "22222222-2222-4222-8222-222222222222";

class FakeBroker {
  public readonly commands: BrowserAutomationCommand[] = [];
  public failure: string | null = null;

  public async execute(input: BrowserToolsExecuteInput): Promise<BrowserToolsResponsePayload> {
    this.commands.push(input.command);
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

function createViewer(): BrowserScreencastViewer & { frames: Uint8Array[] } {
  const frames: Uint8Array[] = [];
  return { frames, sendFrame: (frame) => frames.push(frame) };
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
    registry.handleFrame(jpegFrame(0, "jpeg-bytes"));

    const resized = await registry.subscribe({
      viewer,
      browserId: BROWSER_ID,
      maxWidth: 1600,
      maxHeight: 800,
    });

    // No replay: the viewer already shows that frame, and the re-armed stream
    // sends a fresh one, so a resize costs exactly one frame.
    expect(resized).toEqual({ ok: true, slot: 0, replay: null });
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

  test("fans frames out to every viewer on the slot", async () => {
    const broker = new FakeBroker();
    const registry = new BrowserScreencastRegistry(broker, { stopGraceMs: 0 });
    const first = createViewer();
    const second = createViewer();
    await registry.subscribe({ viewer: first, browserId: BROWSER_ID });
    await registry.subscribe({ viewer: second, browserId: BROWSER_ID });

    registry.handleFrame(jpegFrame(0, "jpeg-bytes"));
    registry.handleFrame(jpegFrame(7, "other-stream"));

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

    registry.handleFrame(jpegFrame(0, "jpeg-bytes"));
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

    registry.handleFrame(jpegFrame(0, "jpeg-bytes"));
    expect(viewer.frames).toHaveLength(1);
  });

  test("replays the last frame to a viewer that joins an existing stream", async () => {
    const broker = new FakeBroker();
    const registry = new BrowserScreencastRegistry(broker, { stopGraceMs: 0 });
    const first = createViewer();
    await registry.subscribe({ viewer: first, browserId: BROWSER_ID });

    registry.handleFrame(jpegFrame(0, "hello"));
    expect(first.frames).toHaveLength(1);

    // Chrome only emits on damage, so a static page leaves a late viewer blank.
    const late = createViewer();
    const subscription = await registry.subscribe({ viewer: late, browserId: BROWSER_ID });

    // Returned rather than pushed: the caller sends it after the subscribe
    // response, otherwise it lands before the viewer has mapped the slot.
    expect(subscription).toEqual({ ok: true, slot: 0, replay: first.frames[0] });
    expect(late.frames).toHaveLength(0);
  });
});
