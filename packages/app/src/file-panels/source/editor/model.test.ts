import { describe, expect, test } from "vitest";
import { FileHandle } from "../../file/handle";
import { InMemoryFileSession } from "../../file/testing";
import { FileEditorModel, getFileConflictCallout, type FileEditorClock } from "./model";

class TestClock implements FileEditorClock {
  private callback: (() => void) | null = null;

  setTimeout(callback: () => void): ReturnType<typeof setTimeout> {
    this.callback = callback;
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimeout(): void {
    this.callback = null;
  }

  get scheduled(): boolean {
    return this.callback !== null;
  }

  fire(): void {
    const callback = this.callback;
    this.callback = null;
    callback?.();
  }
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function openEditor(content: string | Uint8Array = "first\n") {
  const session = new InMemoryFileSession();
  session.put("source.ts", content);
  const handle = new FileHandle(session, { cwd: "/repo", path: "source.ts" }, "/repo/source.ts");
  handle.setObserving(true);
  await settle();
  const clock = new TestClock();
  const model = new FileEditorModel({ file: handle.file, clock });
  model.open();
  await settle();
  return { session, handle, clock, model, disk: () => session.text("source.ts") };
}

describe("FileEditorModel", () => {
  test("loads the file clean", async () => {
    const { model } = await openEditor();

    expect(model.getSnapshot()).toMatchObject({
      status: "clean",
      content: "first\n",
      modified: false,
    });
  });

  test("reports a file it cannot read", async () => {
    const session = new InMemoryFileSession();
    const handle = new FileHandle(session, { cwd: "/repo", path: "gone.ts" }, "/repo/gone.ts");
    const model = new FileEditorModel({ file: handle.file });
    model.open();
    await settle();

    expect(model.getSnapshot()).toMatchObject({ status: "failed", error: "File not found" });
  });

  test("tracks whether the buffer differs from the file", async () => {
    const { model } = await openEditor();

    model.edit("second\n");
    expect(model.getSnapshot()).toMatchObject({ status: "dirty", modified: true });
    model.edit("first\n");
    expect(model.getSnapshot()).toMatchObject({ status: "clean", modified: false });
  });

  test("autosaves the latest edit after inactivity", async () => {
    const { model, clock, disk } = await openEditor();

    model.edit("draft\n");
    model.edit("latest\n");
    clock.fire();
    await settle();

    expect(disk()).toBe("latest\n");
    expect(model.getSnapshot()).toMatchObject({ status: "clean", modified: false });
  });

  test("keeps a newer edit modified when an older save finishes", async () => {
    const { model, disk } = await openEditor();

    model.edit("saved\n");
    const save = model.save();
    model.edit("newer\n");
    await save;

    expect(disk()).toBe("saved\n");
    expect(model.getSnapshot()).toMatchObject({ status: "dirty", modified: true });
  });

  test("keeps CRLF content and the byte order mark in file form", async () => {
    const { model, disk } = await openEditor(
      new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("a\r\nb\n")]),
    );

    expect(model.getSnapshot()).toMatchObject({ content: "a\r\nb\n", lineSeparator: "\r\n" });
    model.edit("c\r\nd\r\n");
    await model.save();

    expect(disk()).toBe("﻿c\r\nd\r\n");
  });

  test("follows the disk while clean", async () => {
    const { session, model } = await openEditor();

    session.put("source.ts", "external\r\n");
    await settle();

    expect(model.getSnapshot()).toMatchObject({
      status: "clean",
      content: "external\r\n",
      lineSeparator: "\r\n",
    });
  });

  test("conflicts when the disk changes under a modified buffer, and overwrites", async () => {
    const { session, model, disk } = await openEditor();

    model.edit("local\n");
    session.put("source.ts", "external\n");
    await settle();
    expect(model.getSnapshot()).toMatchObject({ status: "conflict", content: "local\n" });
    expect(getFileConflictCallout(model.getSnapshot())).toEqual({
      kind: "changed",
      canOverwrite: true,
    });

    await model.overwrite();
    expect(disk()).toBe("local\n");
    expect(model.getSnapshot()).toMatchObject({ status: "clean", conflict: null });
  });

  test("reload discards a conflicted buffer for the disk", async () => {
    const { session, model } = await openEditor();

    model.edit("local\n");
    session.put("source.ts", "external\n");
    await settle();
    await model.reload();

    expect(model.getSnapshot()).toMatchObject({
      status: "clean",
      content: "external\n",
      modified: false,
    });
  });

  test("a save over an unobserved change conflicts instead of writing", async () => {
    const { session, handle, model, disk } = await openEditor();

    handle.setObserving(false);
    session.put("source.ts", "external\n");
    model.edit("local\n");
    await model.save();

    expect(disk()).toBe("external\n");
    expect(model.getSnapshot()).toMatchObject({ status: "conflict", conflict: "changed" });
  });

  test("stays clean when the disk changes back to its own content", async () => {
    const { session, model, clock } = await openEditor();

    model.edit("local\n");
    session.put("source.ts", "first\n");
    await settle();

    expect(model.getSnapshot()).toMatchObject({ status: "dirty", content: "local\n" });
    expect(clock.scheduled).toBe(true);
  });

  test("a deletion conflicts with local changes and stops autosave", async () => {
    const { session, model, clock } = await openEditor();

    model.edit("local\n");
    session.remove("source.ts");
    await settle();

    expect(getFileConflictCallout(model.getSnapshot())).toEqual({ kind: "deleted" });
    expect(clock.scheduled).toBe(false);
  });

  test("a save over a deletion it has not heard about shows the deleted notice", async () => {
    const { session, handle, model } = await openEditor();

    handle.setObserving(false);
    session.remove("source.ts");
    model.edit("local\n");
    await model.save();

    expect(getFileConflictCallout(model.getSnapshot())).toEqual({ kind: "deleted" });
    expect(model.getSnapshot().content).toBe("local\n");
  });

  test("an external change during a save is reconciled after it", async () => {
    const { session, handle, model } = await openEditor();

    model.edit("local\n");
    const resume = handle.holdWrites();
    const save = model.save();
    session.put("source.ts", "external\n");
    resume();
    await save;
    await settle();

    expect(model.getSnapshot()).toMatchObject({ status: "conflict", conflict: "changed" });
  });

  test("reports failed saves without losing the buffer", async () => {
    const { session, model } = await openEditor();

    session.failNextWrite("disk full");
    model.edit("local\n");
    await model.save();

    expect(model.getSnapshot()).toMatchObject({
      status: "error",
      content: "local\n",
      error: "disk full",
    });
  });

  test("flushes a modified buffer when disposed for another panel", async () => {
    const { model, disk } = await openEditor();

    model.edit("switching\n");
    model.dispose({ flush: true });
    await settle();

    expect(disk()).toBe("switching\n");
  });

  test("discards the buffer when the tab closes while holding writes", async () => {
    const { handle, model, disk } = await openEditor();

    model.edit("discarded\n");
    handle.holdWrites();
    model.dispose({ flush: true });
    handle.dispose();
    await settle();

    expect(disk()).toBe("first\n");
  });
});
