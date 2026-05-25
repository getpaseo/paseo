/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractTerminalDropPaths,
  isTerminalDragLeaveOutside,
  isTerminalFileDrag,
  prepareDroppedPathForTerminal,
  prepareDroppedPathsForTerminal,
} from "./terminal-file-drop";

function setDesktopBridge(bridge: unknown): void {
  Object.defineProperty(window, "paseoDesktop", {
    configurable: true,
    value: bridge,
  });
}

function dataTransfer(input: { types?: string[]; files?: File[] }): DataTransfer {
  return {
    types: input.types ?? [],
    files: input.files ?? [],
  } as unknown as DataTransfer;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { paseoDesktop?: unknown }).paseoDesktop;
});

describe("terminal file drop", () => {
  it("detects file drags", () => {
    expect(isTerminalFileDrag(dataTransfer({ types: ["Files"] }))).toBe(true);
    expect(isTerminalFileDrag(dataTransfer({ types: ["text/plain"] }))).toBe(false);
    expect(isTerminalFileDrag(null)).toBe(false);
  });

  it("keeps drag highlight active when moving between terminal children", () => {
    const root = document.createElement("div");
    const child = document.createElement("div");
    const outside = document.createElement("div");
    root.appendChild(child);

    expect(isTerminalDragLeaveOutside({ currentTarget: root, relatedTarget: child })).toBe(false);
    expect(isTerminalDragLeaveOutside({ currentTarget: root, relatedTarget: outside })).toBe(true);
    expect(isTerminalDragLeaveOutside({ currentTarget: root, relatedTarget: null })).toBe(true);
  });

  it("extracts paths through Electron webUtils", () => {
    const file = new File(["image"], "photo.png", { type: "image/png" });
    const getPathForFile = vi.fn(() => "/Users/me/Desktop/photo.png");
    setDesktopBridge({
      webUtils: { getPathForFile },
    });

    expect(extractTerminalDropPaths(dataTransfer({ types: ["Files"], files: [file] }))).toEqual([
      "/Users/me/Desktop/photo.png",
    ]);
    expect(getPathForFile).toHaveBeenCalledWith(file);
  });

  it("falls back to legacy Electron file paths", () => {
    const file = new File(["image"], "photo.png", { type: "image/png" });
    Object.defineProperty(file, "path", {
      configurable: true,
      value: "/tmp/legacy-photo.png",
    });
    setDesktopBridge({
      webUtils: {
        getPathForFile: vi.fn(() => {
          throw new Error("not available");
        }),
      },
    });

    expect(extractTerminalDropPaths(dataTransfer({ types: ["Files"], files: [file] }))).toEqual([
      "/tmp/legacy-photo.png",
    ]);
  });

  it("drops browser files that have no filesystem path", () => {
    const file = new File(["image"], "photo.png", { type: "image/png" });

    expect(extractTerminalDropPaths(dataTransfer({ types: ["Files"], files: [file] }))).toEqual([]);
  });

  it("prepares POSIX paths with conservative escaping", () => {
    setDesktopBridge({ platform: "darwin" });

    expect(prepareDroppedPathForTerminal("/tmp/my image.png")).toBe("'/tmp/my image.png'");
    expect(prepareDroppedPathForTerminal("/tmp/a$(touch bad).png")).toBe("'/tmp/a(touch bad).png'");
    expect(prepareDroppedPathForTerminal("/tmp/it's.png")).toBe("'/tmp/it\\'s.png'");
  });

  it("prepares Windows paths with space quoting", () => {
    setDesktopBridge({ platform: "win32" });

    expect(prepareDroppedPathForTerminal("C:\\Users\\me\\photo.png")).toBe(
      "C:\\Users\\me\\photo.png",
    );
    expect(prepareDroppedPathForTerminal("C:\\Users\\me\\photo one.png")).toBe(
      '"C:\\Users\\me\\photo one.png"',
    );
  });

  it("joins multiple dropped paths for one terminal input", () => {
    setDesktopBridge({ platform: "darwin" });

    expect(prepareDroppedPathsForTerminal(["/tmp/a.png", "/tmp/b c.png"])).toBe(
      "'/tmp/a.png' '/tmp/b c.png'",
    );
  });
});
