import { encodeBrowserScreencastFrame } from "@getpaseo/protocol/binary-frames/screencast";
import type { BrowserAutomationCommand } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { describe, expect, test } from "vitest";
import type { BrowserToolsExecuteInput } from "./broker.js";
import { browserToolsFailure, type BrowserToolsResponsePayload } from "./errors.js";
import { BrowserScreencastRegistry, type BrowserScreencastViewer } from "./screencast.js";

const BROWSER_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_BROWSER_ID = "22222222-2222-4222-8222-222222222222";
const HOST_CLIENT_ID = "browser-host-1";

class FakeBroker {
  public readonly commands: BrowserAutomationCommand[] = [];
  public failure: string | null = null;
  public workspaceId: string | null = null;
  private nextGate: Promise<void> | null = null;

  public getBrowserHostClientId(): string {
    return HOST_CLIENT_ID;
  }

  public getBrowserWorkspaceId(): string | null {
    return this.workspaceId;
  }

  public pauseNext(): () => void {
    let release = () => {};
    this.nextGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  }

  public async execute(input: BrowserToolsExecuteInput): Promise<BrowserToolsResponsePayload> {
    this.commands.push(input.command);
    const gate = this.nextGate;
    this.nextGate = null;
    await gate;
    if (this.failure) {
      return browserToolsFailure({
        requestId: "req-1",
        code: "browser_no_host",
        message: this.failure,
      });
    }
    return { requestId: "req-1", ok: true, result: screencastResult(input.command) };
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
  return { frames, sendFrame: async (frame) => void frames.push(frame) };
}

function setup(stopGraceMs = 0) {
  const broker = new FakeBroker();
  return {
    broker,
    registry: new BrowserScreencastRegistry(broker, { stopGraceMs }),
    viewer: createViewer(),
  };
}

type SubscribeOptions = Omit<
  Parameters<BrowserScreencastRegistry["subscribe"]>[0],
  "viewer" | "browserId"
>;

function subscribe(
  registry: BrowserScreencastRegistry,
  viewer: BrowserScreencastViewer,
  browserId = BROWSER_ID,
  options: SubscribeOptions = {},
) {
  return registry.subscribe({ viewer, browserId, ...options });
}

function jpegFrame(slot: number, payload: string) {
  return {
    opcode: 0x20 as const,
    slot,
    metadata: { deviceWidth: 1280, deviceHeight: 800 },
    payload: new TextEncoder().encode(payload),
  };
}

function encodedFrame(payload: string): Uint8Array {
  return encodeBrowserScreencastFrame(jpegFrame(0, payload));
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("BrowserScreencastRegistry", () => {
  test("shares one capture and fans its frames out to every viewer", async () => {
    const { broker, registry, viewer: first } = setup();
    const second = createViewer();

    await expect(subscribe(registry, first)).resolves.toEqual({ ok: true, slot: 0, replay: null });
    await expect(subscribe(registry, second)).resolves.toEqual({ ok: true, slot: 0, replay: null });
    registry.handleFrame({ frame: jpegFrame(0, "jpeg"), sourceClientId: HOST_CLIENT_ID });
    registry.handleFrame({ frame: jpegFrame(7, "other"), sourceClientId: HOST_CLIENT_ID });

    expect(broker.commands).toEqual([startCommand({ maxWidth: 2560, maxHeight: 1600 })]);
    expect(first.frames).toEqual([encodedFrame("jpeg")]);
    expect(second.frames).toEqual(first.frames);
  });

  test("tracks the largest viewer without needless re-arms", async () => {
    const { broker, registry, viewer: phone } = setup();
    const desktop = createViewer();
    const small = createViewer();

    await subscribe(registry, phone, BROWSER_ID, { maxWidth: 960, maxHeight: 1920 });
    await subscribe(registry, desktop, BROWSER_ID, { maxWidth: 3840, maxHeight: 1280 });
    await subscribe(registry, small, BROWSER_ID, { maxWidth: 640, maxHeight: 480 });
    await registry.unsubscribe({ viewer: desktop, browserId: BROWSER_ID });
    await flush();

    expect(broker.commands).toEqual([
      startCommand({ maxWidth: 960, maxHeight: 1920 }),
      startCommand({ maxWidth: 3840, maxHeight: 1920 }),
      startCommand({ maxWidth: 960, maxHeight: 1920 }),
    ]);
  });

  test("uses the default size for viewers that omit dimensions", async () => {
    const { broker, registry, viewer: declaring } = setup();
    const silent = createViewer();

    await subscribe(registry, declaring, BROWSER_ID, { maxWidth: 640 });
    await subscribe(registry, silent);
    await registry.unsubscribe({ viewer: declaring, browserId: BROWSER_ID });

    expect(broker.commands).toEqual([
      startCommand({ maxWidth: 640, maxHeight: 1600 }),
      startCommand({ maxWidth: 2560, maxHeight: 1600 }),
    ]);
  });

  test("replays the last frame to late and remounted panes", async () => {
    const { broker, registry, viewer } = setup();
    await subscribe(registry, viewer, BROWSER_ID, { maxWidth: 1280, maxHeight: 800 });
    registry.handleFrame({ frame: jpegFrame(0, "jpeg"), sourceClientId: HOST_CLIENT_ID });

    await expect(subscribe(registry, createViewer())).resolves.toEqual({
      ok: true,
      slot: 0,
      replay: viewer.frames[0],
    });
    await expect(
      subscribe(registry, viewer, BROWSER_ID, { maxWidth: 1600, maxHeight: 800 }),
    ).resolves.toEqual({ ok: true, slot: 0, replay: viewer.frames[0] });

    expect(broker.commands).toEqual([
      startCommand({ maxWidth: 1280, maxHeight: 800 }),
      startCommand({ maxWidth: 2560, maxHeight: 1600 }),
    ]);
  });

  test("removes a disconnected viewer from all its streams", async () => {
    const { broker, registry, viewer: leaving } = setup();
    const staying = createViewer();
    await subscribe(registry, leaving);
    await subscribe(registry, staying);
    await subscribe(registry, leaving, SECOND_BROWSER_ID);

    await registry.removeViewer(leaving);
    registry.handleFrame({ frame: jpegFrame(0, "jpeg"), sourceClientId: HOST_CLIENT_ID });

    expect(broker.commands.filter(({ command }) => command === "screencast_stop")).toEqual([
      { command: "screencast_stop", args: { browserId: SECOND_BROWSER_ID } },
    ]);
    expect(leaving.frames).toEqual([]);
    expect(staying.frames).toEqual([encodedFrame("jpeg")]);
  });

  test("only the same browser reuses a slot while its stop is in flight", async () => {
    const { broker, registry, viewer: leaving } = setup();
    await subscribe(registry, leaving);
    const releaseStop = broker.pauseNext();
    const teardown = registry.unsubscribe({ viewer: leaving, browserId: BROWSER_ID });
    await flush();

    const other = createViewer();
    await expect(subscribe(registry, other, SECOND_BROWSER_ID)).resolves.toMatchObject({ slot: 1 });
    registry.handleFrame({ frame: jpegFrame(0, "stale"), sourceClientId: HOST_CLIENT_ID });
    const returning = subscribe(registry, leaving);
    expect(other.frames).toEqual([]);

    releaseStop();
    await teardown;
    await expect(returning).resolves.toMatchObject({ slot: 0 });
    expect(broker.commands.map(({ command }) => command)).toEqual([
      "screencast_start",
      "screencast_stop",
      "screencast_start",
      "screencast_start",
    ]);
  });

  test("a viewer returning within the grace keeps the capture armed", async () => {
    const { broker, registry, viewer } = setup(20);
    await subscribe(registry, viewer);

    const teardown = registry.unsubscribe({ viewer, browserId: BROWSER_ID });
    await expect(subscribe(registry, viewer)).resolves.toMatchObject({ slot: 0 });
    await teardown;

    expect(broker.commands.map(({ command }) => command)).toEqual(["screencast_start"]);
  });

  test("orders a new start after an in-flight resize and stop", async () => {
    const { broker, registry, viewer } = setup();
    await subscribe(registry, viewer, BROWSER_ID, { maxWidth: 1280, maxHeight: 800 });
    const releaseResize = broker.pauseNext();
    await subscribe(registry, viewer, BROWSER_ID, { maxWidth: 1600, maxHeight: 800 });

    const teardown = registry.unsubscribe({ viewer, browserId: BROWSER_ID });
    await flush();
    const returning = subscribe(registry, viewer);
    releaseResize();
    await teardown;
    await expect(returning).resolves.toMatchObject({ slot: 0 });

    expect(broker.commands.map(({ command }) => command)).toEqual([
      "screencast_start",
      "screencast_start",
      "screencast_stop",
      "screencast_start",
    ]);
  });

  test("reports a failed start and releases its slot", async () => {
    const { broker, registry, viewer } = setup();
    broker.failure = "The app hosting the tab disconnected.";

    await expect(subscribe(registry, viewer)).resolves.toEqual({
      ok: false,
      error: broker.failure,
    });
    broker.failure = null;
    await expect(subscribe(registry, viewer)).resolves.toEqual({ ok: true, slot: 0, replay: null });
  });

  test("fails cleanly when all 256 slots are occupied", async () => {
    const { registry, viewer } = setup();
    for (let index = 0; index < 256; index += 1) {
      await subscribe(registry, viewer, `browser-${index}`);
    }

    await expect(subscribe(registry, viewer)).resolves.toEqual({
      ok: false,
      error: "All browser screencast slots are in use.",
    });
  });

  test("keeps only the latest frame behind a stalled send, then resumes", async () => {
    const frames: Uint8Array[] = [];
    let settle = () => {};
    const viewer: BrowserScreencastViewer = {
      sendFrame: (frame) => {
        frames.push(frame);
        return new Promise<void>((resolve) => {
          settle = resolve;
        });
      },
    };
    const { registry } = setup();
    await subscribe(registry, viewer);

    for (let index = 0; index < 50; index += 1) {
      registry.handleFrame({
        frame: jpegFrame(0, `frame-${index}`),
        sourceClientId: HOST_CLIENT_ID,
      });
    }
    settle();
    await flush();
    settle();
    await flush();
    registry.handleFrame({ frame: jpegFrame(0, "after-drain"), sourceClientId: HOST_CLIENT_ID });

    expect(frames).toEqual([
      encodedFrame("frame-0"),
      encodedFrame("frame-49"),
      encodedFrame("after-drain"),
    ]);
  });

  test.each([
    ["one oversized viewer", [{ maxWidth: 100_000, maxHeight: 100_000 }]],
    [
      "the combined viewer box",
      [
        { maxWidth: 4096, maxHeight: 8 },
        { maxWidth: 8, maxHeight: 4096 },
      ],
    ],
  ])("clamps %s to the encode budget", async (_name, sizes) => {
    const { broker, registry } = setup();
    for (const size of sizes) {
      await subscribe(registry, createViewer(), BROWSER_ID, size);
    }
    expect(broker.commands.at(-1)).toEqual(startCommand({ maxWidth: 2880, maxHeight: 2880 }));
  });

  test("rejects frames from a session that does not own the capture", async () => {
    const { registry, viewer } = setup();
    await subscribe(registry, viewer);

    registry.handleFrame({ frame: jpegFrame(0, "forged"), sourceClientId: "another-client" });
    registry.handleFrame({ frame: jpegFrame(0, "genuine"), sourceClientId: HOST_CLIENT_ID });

    expect(viewer.frames).toEqual([encodedFrame("genuine")]);
  });

  test.each([
    ["new capture", () => Promise.resolve(), 0],
    [
      "running capture",
      (registry: BrowserScreencastRegistry, viewer: BrowserScreencastViewer) =>
        subscribe(registry, viewer, BROWSER_ID, { workspaceId: "workspace-1" }),
      1,
    ],
  ])("rejects another workspace from a %s", async (_name, seed, commandCount) => {
    const { broker, registry } = setup();
    broker.workspaceId = "workspace-1";
    await seed(registry, createViewer());
    const intruder = createViewer();

    await expect(
      subscribe(registry, intruder, BROWSER_ID, { workspaceId: "workspace-2" }),
    ).resolves.toEqual({
      ok: false,
      error: `Browser tab ${BROWSER_ID} is not in workspace workspace-2.`,
    });
    registry.handleFrame({ frame: jpegFrame(0, "jpeg"), sourceClientId: HOST_CLIENT_ID });

    expect(broker.commands).toHaveLength(commandCount);
    expect(intruder.frames).toEqual([]);
  });
});
