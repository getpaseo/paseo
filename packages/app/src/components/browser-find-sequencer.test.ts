import { describe, expect, it } from "vitest";
import {
  createBrowserFindSequencer,
  type BrowserFindOptions,
  type BrowserFindPort,
  type BrowserFindResult,
} from "./browser-find-sequencer";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeBrowserFindPort implements BrowserFindPort {
  readonly requests: Array<{ query: string; options: BrowserFindOptions }> = [];
  readonly pendingRequests: Array<Deferred<number | null>> = [];
  readonly stopActions: Array<"clearSelection"> = [];

  findInPage(query: string, options: BrowserFindOptions) {
    this.requests.push({ query, options });
    const request = createDeferred<number | null>();
    this.pendingRequests.push(request);
    return request.promise;
  }

  stopFindInPage(action: "clearSelection") {
    this.stopActions.push(action);
  }
}

function result(requestId: number): BrowserFindResult {
  return { requestId, activeMatchOrdinal: 2, matches: 5, finalUpdate: true };
}

async function flushPromises() {
  await Promise.resolve();
}

describe("createBrowserFindSequencer", () => {
  it("sends initial and directional navigation requests through the port", () => {
    const port = new FakeBrowserFindPort();
    const sequencer = createBrowserFindSequencer(port, {
      onUnavailable: () => {},
      onResult: () => {},
    });

    sequencer.request("hello", { findNext: false, forward: true });
    sequencer.request("hello", { findNext: true, forward: false });

    expect(port.requests).toEqual([
      { query: "hello", options: { findNext: false, forward: true } },
      { query: "hello", options: { findNext: true, forward: false } },
    ]);
  });

  it("accepts only results belonging to the latest resolved request", async () => {
    const port = new FakeBrowserFindPort();
    const results: BrowserFindResult[] = [];
    const sequencer = createBrowserFindSequencer(port, {
      onUnavailable: () => {},
      onResult: (nextResult) => results.push(nextResult),
    });

    sequencer.request("foo", { findNext: false, forward: true });
    sequencer.request("foobar", { findNext: false, forward: true });
    port.pendingRequests[0]?.resolve(1);
    port.pendingRequests[1]?.resolve(2);
    await flushPromises();

    sequencer.receive(result(1));
    sequencer.receive(result(2));

    expect(results).toEqual([result(2)]);
  });

  it("accepts a result emitted before the latest request id resolves", async () => {
    const port = new FakeBrowserFindPort();
    const results: BrowserFindResult[] = [];
    const sequencer = createBrowserFindSequencer(port, {
      onUnavailable: () => {},
      onResult: (nextResult) => results.push(nextResult),
    });

    sequencer.request("foo", { findNext: false, forward: true });
    sequencer.receive(result(1));
    port.pendingRequests[0]?.resolve(1);
    await flushPromises();

    expect(results).toEqual([result(1)]);
  });

  it("keeps the latest early result when an earlier request resolves afterwards", async () => {
    const port = new FakeBrowserFindPort();
    const results: BrowserFindResult[] = [];
    const sequencer = createBrowserFindSequencer(port, {
      onUnavailable: () => {},
      onResult: (nextResult) => results.push(nextResult),
    });

    sequencer.request("first", { findNext: false, forward: true });
    sequencer.request("second", { findNext: false, forward: true });
    sequencer.receive(result(2));
    port.pendingRequests[0]?.resolve(1);
    await flushPromises();
    port.pendingRequests[1]?.resolve(2);
    await flushPromises();

    expect(results).toEqual([result(2)]);
  });

  it("clears state when the latest request is unavailable or fails", async () => {
    const port = new FakeBrowserFindPort();
    let unavailableCount = 0;
    const sequencer = createBrowserFindSequencer(port, {
      onUnavailable: () => {
        unavailableCount += 1;
      },
      onResult: () => {},
    });

    sequencer.request("foo", { findNext: false, forward: true });
    port.pendingRequests[0]?.resolve(null);
    await flushPromises();

    sequencer.request("bar", { findNext: false, forward: true });
    port.pendingRequests[1]?.reject(new Error("IPC unavailable"));
    await flushPromises();

    expect(unavailableCount).toBe(2);
  });

  it("invalidates pending results and clears Electron selection", async () => {
    const port = new FakeBrowserFindPort();
    const results: BrowserFindResult[] = [];
    const sequencer = createBrowserFindSequencer(port, {
      onUnavailable: () => {},
      onResult: (nextResult) => results.push(nextResult),
    });

    sequencer.request("foo", { findNext: false, forward: true });
    sequencer.clear();
    port.pendingRequests[0]?.resolve(1);
    await flushPromises();
    sequencer.receive(result(1));

    expect(port.stopActions).toEqual(["clearSelection"]);
    expect(results).toEqual([]);
  });
});
