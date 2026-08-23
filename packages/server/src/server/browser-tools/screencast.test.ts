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
    const registry = new BrowserScreencastRegistry(broker);
    const first = createViewer();
    const second = createViewer();

    const firstSubscription = await registry.subscribe({ viewer: first, browserId: BROWSER_ID });
    const secondSubscription = await registry.subscribe({ viewer: second, browserId: BROWSER_ID });

    expect(firstSubscription).toEqual({ ok: true, slot: 0 });
    expect(secondSubscription).toEqual({ ok: true, slot: 0 });
    expect(broker.commands).toEqual([
      {
        command: "screencast_start",
        args: {
          browserId: BROWSER_ID,
          slot: 0,
          quality: 60,
          maxWidth: 1280,
          maxHeight: 800,
          everyNthFrame: 1,
        },
      },
    ]);
  });

  test("stops the host only once the last viewer unsubscribes", async () => {
    const broker = new FakeBroker();
    const registry = new BrowserScreencastRegistry(broker);
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
    const registry = new BrowserScreencastRegistry(broker);
    const viewer = createViewer();

    const first = await registry.subscribe({ viewer, browserId: BROWSER_ID });
    const second = await registry.subscribe({ viewer, browserId: SECOND_BROWSER_ID });
    expect(first).toEqual({ ok: true, slot: 0 });
    expect(second).toEqual({ ok: true, slot: 1 });

    await registry.unsubscribe({ viewer, browserId: BROWSER_ID });
    const reused = await registry.subscribe({ viewer, browserId: BROWSER_ID });
    expect(reused).toEqual({ ok: true, slot: 0 });
  });

  test("fans frames out to every viewer on the slot", async () => {
    const broker = new FakeBroker();
    const registry = new BrowserScreencastRegistry(broker);
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
    const registry = new BrowserScreencastRegistry(broker);
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
    const registry = new BrowserScreencastRegistry(broker);
    const viewer = createViewer();

    const subscription = await registry.subscribe({ viewer, browserId: BROWSER_ID });
    expect(subscription).toEqual({ ok: false, error: "The app hosting the tab disconnected." });

    broker.failure = null;
    await expect(registry.subscribe({ viewer, browserId: BROWSER_ID })).resolves.toEqual({
      ok: true,
      slot: 0,
    });
  });

  test("subscribing fails cleanly when every slot is taken", async () => {
    const broker = new FakeBroker();
    const registry = new BrowserScreencastRegistry(broker);
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

  test("replays the last frame to a viewer that joins an existing stream", async () => {
    const broker = new FakeBroker();
    const registry = new BrowserScreencastRegistry(broker);
    const first = createViewer();
    await registry.subscribe({ viewer: first, browserId: BROWSER_ID });

    registry.handleFrame(jpegFrame(0, "hello"));
    expect(first.frames).toHaveLength(1);

    // Chrome only emits on damage, so a static page leaves a late viewer blank.
    const late = createViewer();
    await registry.subscribe({ viewer: late, browserId: BROWSER_ID });

    expect(late.frames).toHaveLength(1);
    expect(late.frames[0]).toEqual(first.frames[0]);
  });
});
