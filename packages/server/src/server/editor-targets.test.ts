import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { listAvailableEditorTargets, openInEditorTarget } from "./editor-targets.js";

describe("editor-targets", () => {
  it("lists available editors in deterministic order", async () => {
    const available = new Set(["code", "cursor", "explorer", "webstorm"]);

    const editors = await listAvailableEditorTargets({
      platform: "win32",
      findExecutable: (command) => (available.has(command) ? command : null),
    });

    expect(editors).toEqual([
      { id: "cursor", label: "Cursor" },
      { id: "vscode", label: "VS Code" },
      { id: "webstorm", label: "WebStorm" },
      { id: "explorer", label: "Explorer" },
    ]);
  });

  it("returns Finder on macOS", async () => {
    const editors = await listAvailableEditorTargets({
      platform: "darwin",
      findExecutable: (command) => (command === "open" ? "/usr/bin/open" : null),
    });

    expect(editors).toEqual([{ id: "finder", label: "Finder" }]);
  });

  it("returns the generic file manager target on Linux", async () => {
    const editors = await listAvailableEditorTargets({
      platform: "linux",
      findExecutable: (command) => (command === "xdg-open" ? "/usr/bin/xdg-open" : null),
    });

    expect(editors).toEqual([{ id: "file-manager", label: "File Manager" }]);
  });

  it("launches editors as detached processes", async () => {
    const unref = vi.fn();
    const once = vi.fn((event: string, handler: () => void) => {
      if (event === "spawn") {
        queueMicrotask(handler);
      }
      return child;
    });
    const child = { once, unref };
    const spawn = vi.fn(() => child as unknown as ChildProcess);

    await openInEditorTarget(
      {
        editorId: "vscode",
        path: "/tmp/repo",
      },
      {
        platform: "darwin",
        existsSync: () => true,
        findExecutable: (command) => (command === "code" ? "/usr/local/bin/code" : null),
        spawn,
      },
    );

    expect(spawn).toHaveBeenCalledWith("/usr/local/bin/code", ["/tmp/repo"], {
      detached: true,
      env: expect.any(Object),
      shell: false,
      stdio: "ignore",
    });
    expect(unref).toHaveBeenCalled();
  });

  it("reveals files in Finder on macOS", async () => {
    const once = vi.fn((event: string, handler: () => void) => {
      if (event === "spawn") {
        queueMicrotask(handler);
      }
      return child;
    });
    const child = { once, unref: vi.fn() };
    const spawn = vi.fn(() => child as unknown as ChildProcess);

    await openInEditorTarget(
      {
        editorId: "finder",
        path: "/tmp/repo/src/index.ts",
        mode: "reveal",
      },
      {
        platform: "darwin",
        existsSync: () => true,
        findExecutable: (command) => (command === "open" ? "/usr/bin/open" : null),
        spawn,
      },
    );

    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/open",
      ["-R", "/tmp/repo/src/index.ts"],
      expect.objectContaining({ detached: true }),
    );
  });

  it("reveals files in Explorer on Windows", async () => {
    const once = vi.fn((event: string, handler: () => void) => {
      if (event === "spawn") {
        queueMicrotask(handler);
      }
      return child;
    });
    const child = { once, unref: vi.fn() };
    const spawn = vi.fn(() => child as unknown as ChildProcess);

    await openInEditorTarget(
      {
        editorId: "explorer",
        path: "C:/repo/src/index.ts",
        mode: "reveal",
      },
      {
        platform: "win32",
        existsSync: () => true,
        findExecutable: (command) => (command === "explorer" ? "explorer" : null),
        spawn,
      },
    );

    expect(spawn).toHaveBeenCalledWith(
      "explorer",
      ["/select,", "C:/repo/src/index.ts"],
      expect.objectContaining({ shell: true }),
    );
  });

  it("reveals files by opening the containing folder when reveal is unsupported (Linux)", async () => {
    const once = vi.fn((event: string, handler: () => void) => {
      if (event === "spawn") {
        queueMicrotask(handler);
      }
      return child;
    });
    const child = { once, unref: vi.fn() };
    const spawn = vi.fn(() => child as unknown as ChildProcess);

    await openInEditorTarget(
      {
        editorId: "file-manager",
        path: "/home/user/repo/src/index.ts",
        mode: "reveal",
      },
      {
        platform: "linux",
        existsSync: () => true,
        findExecutable: (command) => (command === "xdg-open" ? "/usr/bin/xdg-open" : null),
        spawn,
      },
    );

    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/xdg-open",
      ["/home/user/repo/src"],
      expect.objectContaining({ detached: true }),
    );
  });

  it("ignores reveal mode for editor targets", async () => {
    const once = vi.fn((event: string, handler: () => void) => {
      if (event === "spawn") {
        queueMicrotask(handler);
      }
      return child;
    });
    const child = { once, unref: vi.fn() };
    const spawn = vi.fn(() => child as unknown as ChildProcess);

    await openInEditorTarget(
      {
        editorId: "vscode",
        path: "/home/user/repo/src/index.ts",
        mode: "reveal",
      },
      {
        platform: "linux",
        existsSync: () => true,
        findExecutable: (command) => (command === "code" ? "/usr/bin/code" : null),
        spawn,
      },
    );

    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/code",
      ["/home/user/repo/src/index.ts"],
      expect.objectContaining({ detached: true }),
    );
  });

  it("rejects relative paths", async () => {
    await expect(
      openInEditorTarget(
        {
          editorId: "cursor",
          path: "repo",
        },
        {
          existsSync: () => true,
          findExecutable: () => "/usr/local/bin/cursor",
        },
      ),
    ).rejects.toThrow("Editor target path must be an absolute local path");
  });

  it("rejects platform-specific targets that are unavailable on this OS", async () => {
    await expect(
      openInEditorTarget(
        {
          editorId: "finder",
          path: "/tmp/repo",
        },
        {
          platform: "linux",
          existsSync: () => true,
          findExecutable: () => "/usr/bin/open",
        },
      ),
    ).rejects.toThrow("Editor target unavailable: Finder");
  });

  it("rejects unknown editor ids", async () => {
    await expect(
      openInEditorTarget(
        {
          editorId: "unknown-editor",
          path: "/tmp/repo",
        },
        {
          existsSync: () => true,
          findExecutable: () => null,
        },
      ),
    ).rejects.toThrow("Unknown editor target: unknown-editor");
  });
});
