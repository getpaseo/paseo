import {
  PluginFileConflictError,
  PluginFileDeletedError,
  type PluginFileEvent,
} from "@getpaseo/plugin/client";
import { describe, expect, it } from "vitest";
import { FileHandle } from "./handle";
import { InMemoryFileSession } from "./testing";

async function openFile(content: string | Uint8Array = "first\n") {
  const session = new InMemoryFileSession();
  session.put("notes.md", content);
  const handle = new FileHandle(session, { cwd: "/repo", path: "notes.md" }, "/repo/notes.md");
  handle.setObserving(true);
  await settle();
  const events: PluginFileEvent["type"][] = [];
  handle.file.watch((event) => events.push(event.type));
  return { session, handle, file: handle.file, events };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("FileHandle", () => {
  it("describes the file from its stat before anything reads it", async () => {
    const { handle, file } = await openFile("# Notes\n");

    expect(handle.getSnapshot()).toMatchObject({ status: "ready", kind: "text", size: 8 });
    expect([file.path, file.name, file.extension, file.mimeType, file.size]).toEqual([
      "/repo/notes.md",
      "notes.md",
      "md",
      "text/plain",
      8,
    ]);
  });

  it("writes over the version it read and refreshes the stat", async () => {
    const { session, file, events } = await openFile();

    expect(await file.readText()).toBe("first\n");
    await file.writeText("second, longer\n");

    expect(session.text("notes.md")).toBe("second, longer\n");
    expect(file.size).toBe(15);
    expect(events).toEqual([]);
  });

  it("rejects a write after an external change unless forced", async () => {
    const { session, file, events } = await openFile();
    await file.readText();

    session.put("notes.md", "external\n");
    await expect(file.writeText("mine\n")).rejects.toBeInstanceOf(PluginFileConflictError);
    expect(session.text("notes.md")).toBe("external\n");

    await file.writeText("mine\n", { force: true });
    expect(session.text("notes.md")).toBe("mine\n");
    expect(events).toEqual(["changed"]);
  });

  it("rejects a write over a deleted file it has not observed yet", async () => {
    const { session, handle, file } = await openFile();
    await file.readText();
    handle.setObserving(false);
    session.remove("notes.md");

    await expect(file.writeText("mine\n")).rejects.toBeInstanceOf(PluginFileDeletedError);
    await expect(file.writeText("mine\n", { force: true })).rejects.toBeInstanceOf(
      PluginFileDeletedError,
    );
  });

  it("forces over a change it has not observed yet", async () => {
    const { session, handle, file } = await openFile();
    await file.readText();
    handle.setObserving(false);
    session.put("notes.md", "unobserved\n");

    await file.writeText("mine\n", { force: true });

    expect(session.text("notes.md")).toBe("mine\n");
  });

  it("keeps a byte order mark it read", async () => {
    const { session, file } = await openFile(
      new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("bom\r\n")]),
    );

    expect(await file.readText()).toBe("bom\r\n");
    await file.writeText("saved\r\n");

    expect(session.text("notes.md")).toBe("﻿saved\r\n");
  });

  it("tells watchers about each external version once, and about deletion", async () => {
    const { session, file, events } = await openFile();

    session.put("notes.md", "external\n");
    await file.readText();
    session.remove("notes.md");
    session.remove("notes.md");
    await settle();
    session.put("notes.md", "restored\n");

    expect(events).toEqual(["changed", "deleted", "changed"]);
  });

  it("keeps the stat of a deleted file, so its panel stays mounted", async () => {
    const { session, handle } = await openFile();

    session.remove("notes.md");
    await settle();

    expect(handle.getSnapshot()).toMatchObject({ status: "ready", kind: "text" });
  });

  it("does not report a deletion when the file is back before a read confirms it", async () => {
    const { session, events } = await openFile();

    session.remove("notes.md");
    session.put("notes.md", "first\n");
    await settle();

    expect(events).toEqual(["changed"]);
  });

  it("reports what changed while the tab was off screen", async () => {
    const { session, handle, events } = await openFile();

    handle.setObserving(false);
    session.put("notes.md", "while hidden\n");
    expect(events).toEqual([]);
    handle.setObserving(true);
    await settle();

    expect(events).toEqual(["changed"]);
    expect(session.observerCount()).toBe(1);
  });

  it("reads after its own pending writes", async () => {
    const { file } = await openFile();
    await file.readText();

    const write = file.writeText("flushed\n");
    const read = file.readText();

    await write;
    expect(await read).toBe("flushed\n");
  });

  it("holds writes while the tab asks to discard them, and drops them when it closes", async () => {
    const { session, handle, file } = await openFile();
    await file.readText();

    const resume = handle.holdWrites();
    const kept = file.writeText("kept\n");
    await settle();
    expect(session.text("notes.md")).toBe("first\n");
    resume();
    await kept;
    expect(session.text("notes.md")).toBe("kept\n");

    handle.holdWrites();
    const dropped = file.writeText("dropped\n");
    handle.dispose();
    await expect(dropped).rejects.toThrow("The file tab was closed.");
    expect(session.text("notes.md")).toBe("kept\n");
  });

  it("owns one URL per version and releases it when replaced or closed", async () => {
    const { session, handle, file } = await openFile();

    const first = await file.url();
    expect(await file.url()).toBe(first);
    session.put("notes.md", "changed\n");
    const second = await file.url();

    expect(second).not.toBe(first);
    expect(session.createdUrls).toEqual([first, second]);
    expect(session.releasedUrls).toEqual([first]);
    handle.dispose();
    expect(session.releasedUrls).toEqual([first, second]);
  });

  it("writes bytes", async () => {
    const { session, file } = await openFile();
    await file.readBytes();

    await file.writeBytes(new Uint8Array([1, 2, 3]));

    expect(session.writes).toEqual(["bytes:3"]);
  });
});
