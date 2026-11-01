import { describe, expect, it, vi } from "vitest";
import type { DesktopHostBridge } from "@/desktop/host";
import type { SelectedFile } from "@/attachments/selected-file";
import { routeTerminalDrop, routeTerminalPickedFile } from "./terminal-file-drop";

function fakeFile(input: { name: string; type?: string; legacyPath?: string }): File {
  const file = { name: input.name, type: input.type ?? "" } as unknown as File;
  if (input.legacyPath !== undefined) {
    Object.defineProperty(file, "path", {
      configurable: true,
      value: input.legacyPath,
    });
  }
  return file;
}

describe("terminal file drop routing", () => {
  const notes = fakeFile({ name: "notes.txt", type: "text/plain" });
  const electron: DesktopHostBridge = {
    webUtils: { getPathForFile: (file) => `/Users/me/Desktop/${file.name}` },
  };

  it("pastes the file's own path when the host is the client's machine", () => {
    expect(
      routeTerminalDrop({ kind: "web-file", file: notes }, { hostIsLocal: true, bridge: electron }),
    ).toEqual({ kind: "path", path: "/Users/me/Desktop/notes.txt" });
  });

  it("uploads the same file when the host is another machine", () => {
    expect(
      routeTerminalDrop(
        { kind: "web-file", file: notes },
        { hostIsLocal: false, bridge: electron },
      ),
    ).toMatchObject({ kind: "upload" });
  });

  it("uploads browser files, which have no path on any machine", () => {
    expect(
      routeTerminalDrop({ kind: "web-file", file: notes }, { hostIsLocal: true, bridge: null }),
    ).toMatchObject({ kind: "upload" });
  });

  it("falls back to legacy Electron file paths on a local host", () => {
    const file = fakeFile({ name: "photo.png", legacyPath: "/tmp/legacy-photo.png" });
    const bridge: DesktopHostBridge = {
      webUtils: {
        getPathForFile: vi.fn(() => {
          throw new Error("not available");
        }),
      },
    };

    expect(routeTerminalDrop({ kind: "web-file", file }, { hostIsLocal: true, bridge })).toEqual({
      kind: "path",
      path: "/tmp/legacy-photo.png",
    });
  });

  it("routes desktop paths by host locality too", () => {
    const item = { kind: "desktop-path", path: "/tmp/report.pdf" } as const;

    expect(routeTerminalDrop(item, { hostIsLocal: true, bridge: null })).toEqual({
      kind: "path",
      path: "/tmp/report.pdf",
    });
    expect(routeTerminalDrop(item, { hostIsLocal: false, bridge: null })).toMatchObject({
      kind: "upload",
    });
  });
});

describe("terminal picked file routing", () => {
  const bytes = new Uint8Array([7, 8, 9]);

  function picked(input: { desktopPath?: string } = {}): SelectedFile {
    return {
      fileName: "report.pdf",
      mimeType: "application/pdf",
      ...input,
      readBytes: async () => bytes,
    };
  }

  it("pastes the desktop dialog's own path when the host is the client's machine", () => {
    expect(
      routeTerminalPickedFile(picked({ desktopPath: "/Users/me/report.pdf" }), {
        hostIsLocal: true,
      }),
    ).toEqual({ kind: "path", path: "/Users/me/report.pdf" });
  });

  it("uploads the desktop dialog's file when the host is another machine", async () => {
    const delivery = routeTerminalPickedFile(picked({ desktopPath: "/Users/me/report.pdf" }), {
      hostIsLocal: false,
    });

    expect(delivery.kind).toBe("upload");
    await expect(delivery.kind === "upload" ? delivery.read() : null).resolves.toEqual({
      fileName: "report.pdf",
      mimeType: "application/pdf",
      bytes,
    });
  });

  it("uploads browser and native document-picker files, which carry no path", () => {
    expect(routeTerminalPickedFile(picked(), { hostIsLocal: true })).toMatchObject({
      kind: "upload",
    });
    expect(routeTerminalPickedFile(picked(), { hostIsLocal: false })).toMatchObject({
      kind: "upload",
    });
  });
});
