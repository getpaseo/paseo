import { describe, expect, test } from "vitest";
import { TerminalPasteQueue } from "./terminal-paste-queue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  let timeout = () => {};
  const output: string[] = [];
  const queue = new TerminalPasteQueue({
    schedule: (callback) => {
      timeout = callback;
      return () => {};
    },
  });
  const send = (data: string) => output.push(data);
  return { queue, output, send, expire: () => timeout() };
}

describe("terminal paste ordering", () => {
  test("holds input from the gesture through acknowledgement, without blocking another terminal", async () => {
    const a = setup();
    const b = setup();
    const upload = deferred<boolean>();
    const paste = a.queue.paste(() => upload.promise);
    a.queue.input("describe\r", a.send);
    b.queue.input("other\r", b.send);
    expect(a.output).toEqual([]);
    expect(b.output).toEqual(["other\r"]);
    a.send("image");
    upload.resolve(true);
    await paste;
    expect(a.output).toEqual(["image", "describe\r"]);
  });
  test("failure preserves text but requires a new Enter", async () => {
    const a = setup();
    const upload = deferred<boolean>();
    const paste = a.queue.paste(() => upload.promise);
    a.queue.input("describe\r\n", a.send);
    upload.resolve(false);
    await paste;
    expect(a.output).toEqual(["describe"]);
    a.queue.input("\r", a.send);
    expect(a.output).toEqual(["describe", "\r"]);
  });
  test("consecutive images remain ordered with intervening input", async () => {
    const a = setup();
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    const one = a.queue.paste(() => first.promise);
    a.queue.input("a", a.send);
    const two = a.queue.paste(() => {
      a.send("second");
      return second.promise;
    });
    a.queue.input("\r", a.send);
    a.send("first");
    first.resolve(true);
    await one;
    expect(a.output).toEqual(["first", "a", "second"]);
    second.resolve(true);
    await two;
    expect(a.output).toEqual(["first", "a", "second", "\r"]);
  });
  test("timeout aborts work and ignores a late successful result", async () => {
    const a = setup();
    const late = deferred<boolean>();
    let signal!: AbortSignal;
    const paste = a.queue.paste((value) => {
      signal = value;
      return late.promise;
    });
    a.queue.input("text\r", a.send);
    a.expire();
    expect(await paste).toBe(false);
    expect(signal.aborted).toBe(true);
    expect(a.output).toEqual(["text"]);
    late.resolve(true);
    await late.promise;
    expect(a.output).toEqual(["text"]);
  });
  test("Ctrl+C cancels active and consecutive images without submitting queued Enter", async () => {
    const a = setup();
    const gate = deferred<boolean>();
    const one = a.queue.paste(() => gate.promise);
    const two = a.queue.paste(async () => {
      a.send("unexpected");
      return true;
    });
    a.queue.input("text\r", a.send);
    a.queue.input("\x03", a.send);
    expect(await one).toBe(false);
    expect(await two).toBe(false);
    expect(a.output).toEqual(["text", "\x03"]);
  });
  test("disconnect/disposal never replays queued input into a replacement connection", async () => {
    const a = setup();
    const gate = deferred<boolean>();
    const paste = a.queue.paste(() => gate.promise);
    a.queue.input("old\r", a.send);
    a.queue.dispose();
    expect(await paste).toBe(false);
    gate.resolve(true);
    await gate.promise;
    a.queue.input("new", a.send);
    expect(a.output).toEqual(["new"]);
  });
  test("enhanced Enter actions are suppressed after failure", async () => {
    const a = setup();
    const gate = deferred<boolean>();
    const paste = a.queue.paste(() => gate.promise);
    a.queue.action((failed) => {
      if (!failed) a.send("enhanced Enter");
    });
    gate.resolve(false);
    await paste;
    expect(a.output).toEqual([]);
  });
});

test("failed paste suppresses enhanced Enter while preserving other keys", async () => {
  const a = setup();
  const gate = deferred<boolean>();
  const paste = a.queue.paste(() => gate.promise);
  a.queue.input("text\x1b[13;5u\x1b[27;2;13~\x1b[A", a.send);
  gate.resolve(false);
  await paste;
  expect(a.output).toEqual(["text\x1b[A"]);
});
