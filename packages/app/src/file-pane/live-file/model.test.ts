import type { FileReadResult } from "@getpaseo/client/internal/daemon-client";
import type { FileVersion } from "@getpaseo/protocol/messages";
import { describe, expect, it, vi } from "vitest";
import { LiveFileModel, type LiveFileSession, type LiveFileSubscription } from "./model";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function ready(revision = "revision-1"): Extract<FileVersion, { status: "ready" }> {
  return {
    status: "ready",
    cwd: "/workspace",
    path: "file.ts",
    size: 3,
    modifiedAt: "2026-07-30T00:00:00.000Z",
    revision,
  };
}

function file(revision = "revision-1", content = "one"): FileReadResult {
  return {
    bytes: new TextEncoder().encode(content),
    mime: "text/plain",
    size: content.length,
    path: "file.ts",
    kind: "text",
    modifiedAt: "2026-07-30T00:00:00.000Z",
    revision,
  };
}

class TestLiveFileSession implements LiveFileSession {
  readonly reads: Deferred<FileReadResult>[] = [];
  subscribeAttempts = 0;
  private onVersion: ((version: FileVersion) => void) | null = null;
  private readonly initial: FileVersion;

  constructor(initial: FileVersion = ready()) {
    this.initial = initial;
  }

  async subscribe(
    _target: { cwd: string; path: string },
    onVersion: (version: FileVersion) => void,
  ): Promise<LiveFileSubscription> {
    this.subscribeAttempts += 1;
    this.onVersion = onVersion;
    return { initial: this.initial, unsubscribe: () => (this.onVersion = null) };
  }

  read(): Promise<FileReadResult> {
    const request = deferred<FileReadResult>();
    this.reads.push(request);
    return request.promise;
  }

  emit(version: FileVersion): void {
    this.onVersion?.(version);
  }
}

class DeferredSubscribeSession implements LiveFileSession {
  readonly reads: Deferred<FileReadResult>[] = [];
  readonly subscription = deferred<LiveFileSubscription>();
  private onVersion: ((version: FileVersion) => void) | null = null;

  subscribe(
    _target: { cwd: string; path: string },
    onVersion: (version: FileVersion) => void,
  ): Promise<LiveFileSubscription> {
    this.onVersion = onVersion;
    return this.subscription.promise;
  }

  read(): Promise<FileReadResult> {
    const request = deferred<FileReadResult>();
    this.reads.push(request);
    return request.promise;
  }

  emit(version: FileVersion): void {
    this.onVersion?.(version);
  }
}

class FlakySubscriptionSession extends TestLiveFileSession {
  override async subscribe(
    target: { cwd: string; path: string },
    onVersion: (version: FileVersion) => void,
  ): Promise<LiveFileSubscription> {
    if (this.subscribeAttempts === 0) {
      this.subscribeAttempts += 1;
      throw new Error("Connection closed.");
    }
    return super.subscribe(target, onVersion);
  }
}

async function waitForRead(
  session: { reads: Deferred<FileReadResult>[] },
  count: number,
): Promise<void> {
  await vi.waitFor(() => expect(session.reads).toHaveLength(count));
}

describe("LiveFileModel", () => {
  it("reports initial and read-pending work before any terminal observation", async () => {
    const session = new TestLiveFileSession();
    const model = new LiveFileModel();
    model.open({ session, target: { cwd: "/workspace", path: "file.ts" }, liveUpdates: false });
    await waitForRead(session, 1);
    expect(model.getSnapshot()).toEqual({
      observation: null,
      read: { status: "pending", requested: false },
    });
  });

  it("reports read error as terminal and recovers on refresh", async () => {
    const session = new TestLiveFileSession();
    const model = new LiveFileModel();
    model.open({ session, target: { cwd: "/workspace", path: "file.ts" }, liveUpdates: false });
    await waitForRead(session, 1);
    session.reads[0].reject(new Error("read failed"));
    await vi.waitFor(() =>
      expect(model.getSnapshot().read).toEqual({ status: "error", error: "read failed" }),
    );
    model.refresh();
    await waitForRead(session, 2);
    session.reads[1].resolve(file("revision-2"));
    await vi.waitFor(() => expect(model.getObservation()?.status).toBe("ready"));
  });
  it("does not publish a missing candidate when the following read succeeds", async () => {
    const session = new TestLiveFileSession();
    const model = new LiveFileModel();
    model.open({
      session,
      target: { cwd: "/workspace", path: "file.ts" },
      liveUpdates: true,
    });
    await waitForRead(session, 1);
    session.reads[0].resolve(file());
    await vi.waitFor(() => expect(model.getObservation()).toMatchObject({ status: "ready" }));
    const publishedStatuses: string[] = [];
    model.subscribe(() => {
      const observation = model.getObservation();
      if (observation) publishedStatuses.push(observation.status);
    });

    session.emit({ status: "missing", cwd: "/workspace", path: "file.ts" });
    await waitForRead(session, 2);
    session.reads[1].resolve(file());
    await vi.waitFor(() => expect(model.getSnapshot().read).toEqual({ status: "idle" }));

    expect(publishedStatuses).not.toContain("missing");
  });

  it("publishes missing when the following read also fails", async () => {
    const session = new TestLiveFileSession();
    const model = new LiveFileModel();
    model.open({
      session,
      target: { cwd: "/workspace", path: "file.ts" },
      liveUpdates: true,
    });
    await waitForRead(session, 1);
    session.reads[0].resolve(file());
    await vi.waitFor(() => expect(model.getObservation()?.status).toBe("ready"));

    session.emit({ status: "missing", cwd: "/workspace", path: "file.ts" });
    await waitForRead(session, 2);
    session.reads[1].reject(new Error("File not found."));

    await vi.waitFor(() => expect(model.getObservation()?.status).toBe("missing"));
  });

  it("preserves a missing candidate for its queued confirming read", async () => {
    const session = new TestLiveFileSession();
    const model = new LiveFileModel();
    model.open({
      session,
      target: { cwd: "/workspace", path: "file.ts" },
      liveUpdates: true,
    });
    await waitForRead(session, 1);

    session.emit({ status: "missing", cwd: "/workspace", path: "file.ts" });
    session.reads[0].resolve(file());
    await waitForRead(session, 2);
    session.reads[1].reject(new Error("File not found."));

    await vi.waitFor(() => expect(model.getObservation()?.status).toBe("missing"));
  });

  it("recovers only from a read begun after a missing observation", async () => {
    const session = new TestLiveFileSession();
    const model = new LiveFileModel();
    model.open({
      session,
      target: { cwd: "/workspace", path: "file.ts" },
      liveUpdates: true,
    });
    await waitForRead(session, 1);
    session.reads[0].resolve(file());
    await vi.waitFor(() => expect(model.getObservation()).toMatchObject({ status: "ready" }));

    model.refresh();
    await waitForRead(session, 2);
    session.emit({ status: "missing", cwd: "/workspace", path: "file.ts" });
    session.reads[1].resolve(file("revision-2", "two"));

    await waitForRead(session, 3);
    expect(model.getObservation()?.status).toBe("ready");
    expect(model.getSnapshot().read).toEqual({ status: "pending", requested: true });

    session.reads[2].resolve(file("revision-2", "two"));
    await vi.waitFor(() => {
      expect(model.getSnapshot()).toMatchObject({
        observation: {
          status: "ready",
          version: { revision: "revision-2" },
          file: { revision: "revision-2" },
        },
        read: { status: "idle" },
      });
    });
  });

  it("keeps an actionable error visible while refresh fails", async () => {
    const session = new TestLiveFileSession();
    const model = new LiveFileModel();
    model.open({
      session,
      target: { cwd: "/workspace", path: "file.ts" },
      liveUpdates: true,
    });
    await waitForRead(session, 1);
    session.reads[0].resolve(file());
    await vi.waitFor(() => expect(model.getObservation()).toMatchObject({ status: "ready" }));

    session.emit({
      status: "error",
      cwd: "/workspace",
      path: "file.ts",
      error: "Requested path is not a file",
    });
    await waitForRead(session, 2);
    expect(model.getSnapshot().read).toEqual({ status: "pending", requested: false });
    session.reads[1].reject(new Error("File unavailable."));

    await vi.waitFor(() => {
      expect(model.getSnapshot()).toMatchObject({
        observation: { status: "error", error: "Requested path is not a file" },
        read: { status: "error", error: "File unavailable." },
      });
    });

    model.refresh();
    await waitForRead(session, 3);
    expect(model.getSnapshot().read).toEqual({ status: "pending", requested: true });
  });

  it("keeps an update that arrives before the subscription response", async () => {
    const session = new DeferredSubscribeSession();
    const model = new LiveFileModel();
    model.open({
      session,
      target: { cwd: "/workspace", path: "file.ts" },
      liveUpdates: true,
    });

    session.emit(ready("revision-2"));
    session.subscription.resolve({ initial: ready("revision-1"), unsubscribe() {} });

    await waitForRead(session, 1);
    expect(model.getObservation()).toBeNull();
  });

  it("retries a failed subscription when the user refreshes", async () => {
    const session = new FlakySubscriptionSession();
    const model = new LiveFileModel();
    model.open({
      session,
      target: { cwd: "/workspace", path: "file.ts" },
      liveUpdates: true,
    });
    await waitForRead(session, 1);
    expect(session.subscribeAttempts).toBe(1);

    session.reads[0].resolve(file());
    await vi.waitFor(() => expect(model.getObservation()?.status).toBe("ready"));
    model.refresh();

    await waitForRead(session, 2);
    expect(session.subscribeAttempts).toBe(2);
    expect(model.getSnapshot().read).toEqual({ status: "pending", requested: true });
  });

  it("reads once without subscribing when live updates are disabled", async () => {
    const session = new TestLiveFileSession();
    const model = new LiveFileModel();
    model.open({
      session,
      target: { cwd: "/workspace", path: "file.ts" },
      liveUpdates: false,
    });

    await waitForRead(session, 1);
    expect(session.subscribeAttempts).toBe(0);
    expect(model.getSnapshot().read).toEqual({ status: "pending", requested: false });
  });

  it("ignores a read that completes after the model closes", async () => {
    const session = new TestLiveFileSession();
    const model = new LiveFileModel();
    model.open({
      session,
      target: { cwd: "/workspace", path: "file.ts" },
      liveUpdates: true,
    });
    await waitForRead(session, 1);

    model.close();
    session.reads[0].resolve(file());
    await Promise.resolve();

    expect(model.getSnapshot()).toEqual({
      observation: null,
      read: { status: "idle" },
    });
  });
});
