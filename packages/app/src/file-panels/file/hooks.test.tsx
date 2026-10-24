// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { PluginFileDeletedError, useFileText, useFileUrl } from "@getpaseo/plugin/client";
import { describe, expect, it } from "vitest";
import { FileHandle } from "./handle";
import { InMemoryFileSession } from "./testing";

function openFile(content = "first\n") {
  const session = new InMemoryFileSession();
  session.put("notes.md", content);
  const handle = new FileHandle(session, { cwd: "/repo", path: "notes.md" }, "/repo/notes.md");
  handle.setObserving(true);
  return { session, handle, file: handle.file };
}

describe("file hooks", () => {
  it("reads the text, then follows changes without going back to loading", async () => {
    const { session, file } = openFile();
    const states: string[] = [];
    const { result } = renderHook(() => {
      const text = useFileText(file);
      states.push(text.status);
      return text;
    });

    await waitFor(() => expect(result.current).toEqual({ status: "ready", text: "first\n" }));
    act(() => session.put("notes.md", "second\n"));
    await waitFor(() => expect(result.current).toEqual({ status: "ready", text: "second\n" }));

    expect(states.lastIndexOf("loading")).toBeLessThan(states.indexOf("ready"));
  });

  it("reports a deleted file as a PluginFileDeletedError", async () => {
    const { session, file } = openFile();
    const { result } = renderHook(() => useFileText(file));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => session.remove("notes.md"));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.status === "error" && result.current.error).toBeInstanceOf(
      PluginFileDeletedError,
    );
  });

  it("resolves a URL per version and releases the old one", async () => {
    const { session, file } = openFile();
    const { result } = renderHook(() => useFileUrl(file));
    await waitFor(() => expect(result.current).toEqual({ status: "ready", url: "blob:test/1" }));

    act(() => session.put("notes.md", "second\n"));

    await waitFor(() => expect(result.current).toEqual({ status: "ready", url: "blob:test/2" }));
    expect(session.releasedUrls).toEqual(["blob:test/1"]);
  });
});
