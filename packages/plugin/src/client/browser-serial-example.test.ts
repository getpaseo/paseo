import { describe, expect, it } from "vitest";
import {
  SerialSession,
  type SerialBrowser,
  type SerialPort,
  type BridgeRpc,
} from "../../../../plugin-examples/browser-serial/client/session";
import { MAX_CHUNK_BYTES } from "../../../../plugin-examples/browser-serial/shared/bridge";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const read = deferred<{ done: boolean; value?: Uint8Array }>();
  const poll = deferred<{ data: string; connected: boolean; closed: boolean }>();
  const opened = deferred<void>();
  const created = deferred<{ token: string; port: number }>();
  const writes: Uint8Array[] = [],
    forwarded: Uint8Array[] = [];
  const events: string[] = [];
  let leave = () => {};
  let heartbeat = () => {};
  let firstRead = true,
    firstPoll = true;
  const parkedRead = deferred<{ done: boolean; value?: Uint8Array }>();
  const parkedPoll = deferred<{ data: string; connected: boolean; closed: boolean }>();
  const port: SerialPort = {
    getInfo: () => ({ usbVendorId: 0x1234, usbProductId: 0x5678 }),
    async open() {
      events.push("open");
      await opened.promise;
    },
    async close() {
      events.push("close-port");
    },
    async forget() {
      events.push("forget");
    },
    readable: {
      getReader: () => ({
        read: () => {
          if (firstRead) {
            firstRead = false;
            return read.promise;
          }
          return parkedRead.promise;
        },
        async cancel() {
          events.push("cancel");
          read.resolve({ done: true });
          parkedRead.resolve({ done: true });
        },
        releaseLock() {
          events.push("unlock-reader");
        },
      }),
    },
    writable: {
      getWriter: () => ({
        async write(data) {
          writes.push(data);
        },
        async abort() {
          events.push("abort");
        },
        releaseLock() {
          events.push("unlock-writer");
        },
      }),
    },
  };
  const browser: SerialBrowser = {
    unavailable: null,
    requestPort() {
      events.push("choose");
      return Promise.resolve(port);
    },
    encode: (data) => Buffer.from(data).toString("base64"),
    decode: (data) => new Uint8Array(Buffer.from(data, "base64")),
    onLeave(callback) {
      leave = callback;
      return () => {
        events.push("remove-leave");
      };
    },
  };
  const rpc: BridgeRpc = {
    create() {
      events.push("create");
      return created.promise;
    },
    poll: () => {
      if (firstPoll) {
        firstPoll = false;
        return poll.promise;
      }
      return parkedPoll.promise;
    },
    async write({ data }) {
      forwarded.push(new Uint8Array(Buffer.from(data, "base64")));
    },
    async renew() {
      events.push("renew");
    },
    async close() {
      events.push("close-bridge");
      poll.resolve({ data: "", connected: false, closed: true });
      parkedPoll.resolve({ data: "", connected: false, closed: true });
    },
  };
  const session = new SerialSession(browser, rpc, (callback) => {
    heartbeat = callback;
    return () => {
      events.push("cancel-heartbeat");
      heartbeat = () => {};
    };
  });
  const unmount = session.mount();
  return {
    session,
    browser,
    rpc,
    port,
    read,
    poll,
    opened,
    created,
    writes,
    forwarded,
    events,
    unmount,
    leave: () => leave(),
    heartbeat: () => heartbeat(),
  };
}
async function until(condition: () => boolean) {
  for (let index = 0; index < 100; index++) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error("Expected async transition did not finish");
}
function countEvents(events: string[], name: string) {
  return events.filter((event) => event === name).length;
}
describe("browser serial session", () => {
  it("shows permission removal progress, blocks duplicates and preserves a failed permission for retry", async () => {
    const f = fixture();
    const forgotten = deferred<void>();
    f.port.forget = () => {
      f.events.push("forget");
      return forgotten.promise;
    };
    f.session.connect(9600);
    f.opened.resolve();
    f.created.resolve({ token: "test-token", port: 12345 });
    await until(() => f.session.getSnapshot().phase === "active");
    await f.session.stop();
    const pending = f.session.forget();
    expect(f.session.getSnapshot().phase).toBe("forgetting");
    await f.session.forget();
    f.session.connect(9600);
    expect(f.events.filter((event) => event === "forget")).toHaveLength(1);
    expect(f.events.filter((event) => event === "choose")).toHaveLength(1);
    forgotten.reject(new Error("Permission removal failed"));
    await pending;
    expect(f.session.getSnapshot()).toMatchObject({
      phase: "idle",
      canForget: true,
      error: "Permission removal failed",
    });
    f.port.forget = async () => {};
    await f.session.forget();
    expect(f.session.getSnapshot()).toMatchObject({
      phase: "idle",
      canForget: false,
      label: "No device selected",
      error: null,
    });
    f.unmount();
  });
  it("renews the host lease while a slow serial write is blocked and cancels on stop", async () => {
    const f = fixture();
    const write = deferred<void>();
    const writer = f.port.writable!.getWriter();
    f.port.writable!.getWriter = () => ({
      ...writer,
      async write(data) {
        f.writes.push(data);
        await write.promise;
      },
      async abort() {
        write.resolve();
      },
    });
    f.session.connect(9600);
    f.opened.resolve();
    f.created.resolve({ token: "slow-token", port: 12345 });
    await until(() => f.session.getSnapshot().phase === "active");
    f.poll.resolve({ data: "AP+A", connected: true, closed: false });
    await until(() => f.writes.length === 1);
    f.heartbeat();
    await until(() => countEvents(f.events, "renew") === 1);
    await Promise.resolve();
    f.heartbeat();
    await until(() => countEvents(f.events, "renew") === 2);
    expect(f.session.getSnapshot().phase).toBe("active");
    await f.session.stop();
    f.heartbeat();
    expect(f.events.filter((event) => event === "renew")).toHaveLength(2);
    expect(f.events).toContain("cancel-heartbeat");
    expect(f.events).toContain("close-port");
    f.unmount();
  });
  it("does not overlap renewals and releases the device when renewal fails", async () => {
    const f = fixture();
    const renewal = deferred<void>();
    f.rpc.renew = () => {
      f.events.push("renew");
      return renewal.promise;
    };
    f.session.connect(9600);
    f.opened.resolve();
    f.created.resolve({ token: "test-token", port: 12345 });
    await until(() => f.session.getSnapshot().phase === "active");
    f.heartbeat();
    f.heartbeat();
    expect(f.events.filter((event) => event === "renew")).toHaveLength(1);
    renewal.reject(new Error("Host lease lost"));
    await until(() => f.session.getSnapshot().phase === "idle");
    expect(f.session.getSnapshot().error).toBe("Host lease lost");
    expect(f.events).toContain("close-port");
    expect(f.events).toContain("cancel-heartbeat");
    f.unmount();
  });
  it("does not open a chooser result after leaving the page", async () => {
    const f = fixture();
    const selection = deferred<SerialPort>();
    f.browser.requestPort = () => selection.promise;
    f.session.connect(9600);
    f.unmount();
    selection.resolve(f.port);
    await until(() => f.session.getSnapshot().phase === "idle");
    expect(f.events).not.toContain("open");
    expect(f.events).not.toContain("create");
  });
  it("ends the bridge when the serial stream closes", async () => {
    const f = fixture();
    f.session.connect(9600);
    f.session.connect(9600);
    expect(f.events.filter((event) => event === "choose")).toHaveLength(1);
    f.opened.resolve();
    f.created.resolve({ token: "test-token", port: 12345 });
    await until(() => f.session.getSnapshot().phase === "active");
    f.read.resolve({ done: true });
    await until(() => f.session.getSnapshot().phase === "idle");
    expect(f.session.getSnapshot().error).toBe("The serial device disconnected.");
    expect(f.events).toContain("close-bridge");
    expect(f.events).toContain("close-port");
    f.unmount();
  });
  it("opens only on selection, forwards binary chunks both ways and unlocks the port", async () => {
    const f = fixture();
    expect(f.events).toEqual([]);
    f.session.connect(115200);
    expect(f.events).toEqual(["choose"]);
    f.opened.resolve();
    f.created.resolve({ token: "test-token", port: 12345 });
    await until(() => f.session.getSnapshot().phase === "active");
    expect(f.session.getSnapshot().endpoint).toBe("127.0.0.1:12345");
    const bytes = Uint8Array.from({ length: MAX_CHUNK_BYTES + 3 }, (_, i) => i % 256);
    f.read.resolve({ done: false, value: bytes });
    f.poll.resolve({ data: "AP+A", connected: true, closed: false });
    await until(() => f.forwarded.length === 2 && f.writes.length === 1);
    expect(Buffer.concat(f.forwarded)).toEqual(Buffer.from(bytes));
    expect(f.writes[0]).toEqual(new Uint8Array([0, 255, 128]));
    await f.session.stop();
    expect(f.events.indexOf("close-port")).toBeGreaterThan(f.events.indexOf("unlock-reader"));
    expect(f.events.indexOf("close-port")).toBeGreaterThan(f.events.indexOf("unlock-writer"));
    await f.session.forget();
    expect(f.events).toContain("forget");
    f.unmount();
  });
  it("cleans up an open completed after unmount without creating a bridge", async () => {
    const f = fixture();
    f.session.connect(9600);
    await until(() => f.events.includes("open"));
    f.unmount();
    f.opened.resolve();
    await until(() => f.session.getSnapshot().phase === "idle");
    expect(f.events).toContain("close-port");
    expect(f.events).not.toContain("create");
  });
  it("closes a bridge created after Disconnect", async () => {
    const f = fixture();
    f.session.connect(9600);
    f.opened.resolve();
    await until(() => f.events.includes("create"));
    const stopped = f.session.stop();
    f.created.resolve({ token: "late-token", port: 12345 });
    await stopped;
    expect(f.events).toContain("close-bridge");
    expect(f.session.getSnapshot().endpoint).toBeNull();
    f.unmount();
  });
  it("stops on transport failure without retry or reconnect", async () => {
    const f = fixture();
    f.session.connect(9600);
    f.opened.resolve();
    f.created.resolve({ token: "test-token", port: 12345 });
    await until(() => f.session.getSnapshot().phase === "active");
    f.poll.reject(new Error("Host offline"));
    await until(() => f.session.getSnapshot().phase === "idle");
    expect(f.session.getSnapshot().error).toBe("Host offline");
    expect(f.events.filter((e) => e === "create")).toHaveLength(1);
    f.unmount();
  });
  it("rejects non-USB ports and unsupported clients without opening hardware", async () => {
    const f = fixture();
    f.port.getInfo = () => ({});
    f.session.connect(9600);
    await until(() => f.session.getSnapshot().phase === "idle");
    expect(f.session.getSnapshot().error).toBe("Choose a USB serial device.");
    expect(f.events).not.toContain("open");
    f.browser.unavailable = "Unsupported";
    f.session.connect(9600);
    expect(f.events.filter((e) => e === "choose")).toHaveLength(1);
    f.unmount();
  });
  it("handles picker cancellation and ends an active session on pagehide", async () => {
    const f = fixture();
    f.browser.requestPort = () => Promise.reject(new Error("Picker cancelled"));
    f.session.connect(9600);
    await until(() => f.session.getSnapshot().phase === "idle");
    expect(f.session.getSnapshot().error).toBe("Picker cancelled");
    f.browser.requestPort = () => Promise.resolve(f.port);
    f.session.connect(9600);
    f.opened.resolve();
    f.created.resolve({ token: "test-token", port: 12345 });
    await until(() => f.session.getSnapshot().phase === "active");
    f.leave();
    await until(() => f.session.getSnapshot().phase === "idle");
    expect(f.events).toContain("close-port");
    f.unmount();
  });
});
