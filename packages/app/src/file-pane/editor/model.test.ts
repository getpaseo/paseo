import { describe, expect, test } from "vitest";
import type { FileVersion, FileWriteResult } from "@getpaseo/protocol/messages";
import {
  FileEditorModel,
  type FileEditorClock,
  type FileEditorFile,
  type FileEditorSession,
} from "./model";

class TestClock implements FileEditorClock {
  private callback: (() => void) | null = null;

  setTimeout(callback: () => void): ReturnType<typeof setTimeout> {
    this.callback = callback;
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimeout(): void {
    this.callback = null;
  }

  fire(): void {
    const callback = this.callback;
    this.callback = null;
    callback?.();
  }
}

class FileSession implements FileEditorSession {
  file: FileEditorFile;
  writes: Array<{ content: string; expectedModifiedAt: string; expectedRevision?: string }> = [];
  nextWrite: FileWriteResult | Error | null = null;
  private pendingWrite: Promise<FileWriteResult> | null = null;
  private resolvePendingWrite: ((result: FileWriteResult) => void) | null = null;

  constructor(file: FileEditorFile) {
    this.file = file;
  }

  async read(): Promise<FileEditorFile> {
    return this.file;
  }

  async write(input: {
    content: string;
    expectedModifiedAt: string;
    expectedRevision?: string;
  }): Promise<FileWriteResult> {
    this.writes.push(input);
    if (this.pendingWrite) return this.pendingWrite;
    if (this.nextWrite instanceof Error) throw this.nextWrite;
    if (this.nextWrite) return this.nextWrite;
    return {
      status: "written",
      modifiedAt: "2026-07-18T00:00:01.000Z",
      size: input.content.length,
    };
  }

  holdNextWrite(): void {
    this.pendingWrite = new Promise((resolve) => {
      this.resolvePendingWrite = resolve;
    });
  }

  finishHeldWrite(result: FileWriteResult): void {
    this.resolvePendingWrite?.(result);
    this.pendingWrite = null;
    this.resolvePendingWrite = null;
  }
}

function ready(
  modifiedAt = "2026-07-18T00:00:00.000Z",
  size = 3,
): Extract<FileVersion, { status: "ready" }> {
  return { status: "ready", cwd: "/workspace", path: "file.ts", size, modifiedAt };
}

function makeModel() {
  const file = { content: "one", version: ready() as Extract<FileVersion, { status: "ready" }> };
  const session = new FileSession(file);
  const clock = new TestClock();
  return { model: new FileEditorModel({ file, session, clock }), session, clock };
}

describe("FileEditorModel", () => {
  test("tracks whether the current buffer differs from persisted content", async () => {
    const { model } = makeModel();

    expect(model.getSnapshot().modified).toBe(false);
    model.edit("two");
    expect(model.getSnapshot().modified).toBe(true);
    model.edit("one");
    expect(model.getSnapshot()).toMatchObject({ status: "clean", modified: false });

    model.edit("saved");
    await model.save();
    expect(model.getSnapshot()).toMatchObject({ status: "clean", modified: false });
  });

  test("adopts a precise revision for otherwise unchanged initial metadata", () => {
    const { model } = makeModel();

    model.receiveFileVersion({ ...ready(), revision: "precise-revision" });

    expect(model.getSnapshot().observedVersion).toMatchObject({ revision: "precise-revision" });
  });

  test("keeps a newer edit modified when an older save finishes", async () => {
    const { model, session } = makeModel();
    session.holdNextWrite();
    model.edit("saving");

    const save = model.save();
    model.edit("newer edit");
    session.finishHeldWrite({
      status: "written",
      modifiedAt: "2026-07-18T00:00:01.000Z",
      size: 6,
    });
    await save;

    expect(model.getSnapshot()).toMatchObject({
      status: "dirty",
      content: "newer edit",
      modified: true,
    });
  });

  test("autosaves the latest edit after inactivity", async () => {
    const { model, session, clock } = makeModel();

    model.edit("two");
    model.edit("three");
    clock.fire();
    await Promise.resolve();

    expect(session.writes).toEqual([
      { content: "three", expectedModifiedAt: "2026-07-18T00:00:00.000Z" },
    ]);
    expect(model.getSnapshot().status).toBe("clean");
  });

  test("reloads a clean editor when the disk version changes", async () => {
    const { model, session } = makeModel();
    session.file = {
      content: "external",
      version: ready("2026-07-18T00:00:02.000Z", 8) as Extract<FileVersion, { status: "ready" }>,
    };

    model.receiveFileVersion(session.file.version);
    await Promise.resolve();

    expect(model.getSnapshot()).toMatchObject({ status: "clean", content: "external" });
  });

  test("coalesces consecutive clean disk updates onto the latest reload", async () => {
    const { model, session } = makeModel();
    const reads: Array<(file: FileEditorFile) => void> = [];
    session.read = () => new Promise((resolve) => reads.push(resolve));
    const firstVersion = ready("2026-07-18T00:00:02.000Z", 5);
    const latestVersion = ready("2026-07-18T00:00:03.000Z", 6);

    model.receiveFileVersion(firstVersion);
    model.receiveFileVersion(latestVersion);
    reads[0]?.({ content: "first", version: firstVersion });
    await Promise.resolve();
    reads[1]?.({ content: "latest", version: latestVersion });
    await Promise.resolve();

    expect(model.getSnapshot()).toMatchObject({ status: "clean", content: "latest" });
  });

  test("preserves a dirty buffer and overwrites against the newest disk revision", async () => {
    const { model, session } = makeModel();
    model.edit("local");
    model.receiveFileVersion(ready("2026-07-18T00:00:02.000Z", 4));

    expect(model.getSnapshot()).toMatchObject({ status: "conflict", content: "local" });
    await model.overwrite();

    expect(session.writes).toEqual([
      { content: "local", expectedModifiedAt: "2026-07-18T00:00:02.000Z" },
    ]);
    expect(model.getSnapshot().status).toBe("clean");
  });

  test("reload discards a conflicted local buffer for the disk contents", async () => {
    const { model, session } = makeModel();
    model.edit("local");
    const diskVersion = ready("2026-07-18T00:00:02.000Z", 4) as Extract<
      FileVersion,
      { status: "ready" }
    >;
    session.file = { content: "disk", version: diskVersion };
    model.receiveFileVersion(diskVersion);

    await model.reload();

    expect(model.getSnapshot()).toMatchObject({ status: "clean", content: "disk" });
  });

  test("reports failed saves without losing the local buffer", async () => {
    const { model, session } = makeModel();
    session.nextWrite = new Error("disk full");
    model.edit("important local work");

    await model.save();

    expect(model.getSnapshot()).toMatchObject({
      status: "error",
      content: "important local work",
      error: "disk full",
    });
  });

  test("a deletion conflicts with local changes and stops autosave", () => {
    const { model, session, clock } = makeModel();
    model.edit("local");
    model.receiveFileVersion({ status: "missing", cwd: "/workspace", path: "file.ts" });

    clock.fire();

    expect(model.getSnapshot().status).toBe("conflict");
    expect(session.writes).toEqual([]);
  });

  test("dispose cancels pending autosave", () => {
    const { model, session, clock } = makeModel();
    model.edit("local");

    model.dispose();
    clock.fire();

    expect(session.writes).toEqual([]);
  });

  test("suspends a pending autosave while close confirmation is active", async () => {
    const { model, session, clock } = makeModel();
    model.edit("local");

    const resume = model.suspendAutosave();
    clock.fire();
    expect(session.writes).toEqual([]);

    resume();
    clock.fire();
    await Promise.resolve();
    expect(session.writes).toHaveLength(1);
  });
});
