import type { SpawnOptions } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  listAvailableEditorTargets,
  openEditorTarget,
  registerEditorTargetHandlers,
} from "./editor-targets";

interface SpawnCall {
  command: string;
  args: string[];
  options: SpawnOptions;
  listenedForError: boolean;
  listenedForSpawn: boolean;
  unrefed: boolean;
}

function createExistsSync(paths: readonly string[]): (path: string) => boolean {
  const availablePaths = new Set(paths);
  return (path) => availablePaths.has(path);
}

function createSpawnRecorder() {
  const calls: SpawnCall[] = [];
  const spawn = (command: string, args: string[], options: SpawnOptions) => {
    const call: SpawnCall = {
      command,
      args,
      options,
      listenedForError: false,
      listenedForSpawn: false,
      unrefed: false,
    };
    calls.push(call);
    const child = {
      once: (event: "error" | "spawn", handler: (error?: Error) => void) => {
        if (event === "error") {
          call.listenedForError = true;
        }
        if (event === "spawn") {
          call.listenedForSpawn = true;
          queueMicrotask(() => handler());
        }
        return child;
      },
      unref: () => {
        call.unrefed = true;
      },
    };
    return child;
  };
  return { calls, spawn };
}

describe("desktop editor targets", () => {
  it("lists all known editor targets for the platform in deterministic order", () => {
    const targets = listAvailableEditorTargets({
      platform: "win32",
      env: { PATH: "C:/bin" },
      existsSync: createExistsSync([
        "C:/bin/cursor.exe",
        "C:/bin/code.exe",
        "C:/bin/webstorm.exe",
        "C:/bin/zed.exe",
        "C:/bin/explorer.exe",
      ]),
    });

    expect(targets).toEqual([
      { id: "cursor", label: "Cursor", kind: "editor" },
      { id: "vscode", label: "VS Code", kind: "editor" },
      { id: "webstorm", label: "WebStorm", kind: "editor" },
      { id: "zed", label: "Zed", kind: "editor" },
      { id: "explorer", label: "Explorer", kind: "file-manager" },
    ]);
  });

  it("lists Finder on macOS", () => {
    const targets = listAvailableEditorTargets({
      platform: "darwin",
      env: { PATH: "/usr/bin" },
      existsSync: createExistsSync(["/usr/bin/open"]),
    });

    expect(targets).toEqual([{ id: "finder", label: "Finder", kind: "file-manager" }]);
  });

  it("lists the generic file manager on Linux", () => {
    const targets = listAvailableEditorTargets({
      platform: "linux",
      env: { PATH: "/usr/bin" },
      existsSync: createExistsSync(["/usr/bin/xdg-open"]),
    });

    expect(targets).toEqual([{ id: "file-manager", label: "File Manager", kind: "file-manager" }]);
  });

  it("can list future custom script targets without changing bridge types", () => {
    const targets = listAvailableEditorTargets({
      platform: "linux",
      env: { PATH: "/usr/local/bin" },
      existsSync: createExistsSync(["/usr/local/bin/open-in-nvim"]),
      targetDefinitions: [
        {
          id: "script:open-in-nvim",
          label: "Open in Neovim",
          kind: "editor",
          command: "open-in-nvim",
        },
      ],
    });

    expect(targets).toEqual([
      { id: "script:open-in-nvim", label: "Open in Neovim", kind: "editor" },
    ]);
  });

  it("launches editors as detached external processes", async () => {
    const recorder = createSpawnRecorder();

    await openEditorTarget(
      { editorId: "vscode", path: "/tmp/repo" },
      {
        platform: "darwin",
        env: { PATH: "/usr/local/bin", ELECTRON_RUN_AS_NODE: "1" },
        existsSync: createExistsSync(["/tmp/repo", "/usr/local/bin/code"]),
        spawn: recorder.spawn,
      },
    );

    expect(recorder.calls).toEqual([
      {
        command: "/usr/local/bin/code",
        args: ["/tmp/repo"],
        options: {
          detached: true,
          env: { PATH: "/usr/local/bin" },
          shell: false,
          stdio: "ignore",
        },
        listenedForError: true,
        listenedForSpawn: true,
        unrefed: true,
      },
    ]);
  });

  it("reveals files in Finder on macOS", async () => {
    const recorder = createSpawnRecorder();

    await openEditorTarget(
      { editorId: "finder", path: "/tmp/repo/src/index.ts", mode: "reveal" },
      {
        platform: "darwin",
        env: { PATH: "/usr/bin" },
        existsSync: createExistsSync(["/tmp/repo/src/index.ts", "/usr/bin/open"]),
        spawn: recorder.spawn,
      },
    );

    expect(recorder.calls[0]?.command).toBe("/usr/bin/open");
    expect(recorder.calls[0]?.args).toEqual(["-R", "/tmp/repo/src/index.ts"]);
  });

  it("opens the workspace directory in Explorer using Windows path separators", async () => {
    const recorder = createSpawnRecorder();

    await openEditorTarget(
      { editorId: "explorer", path: "C:/Users/me/project" },
      {
        platform: "win32",
        env: { PATH: "C:/Windows" },
        existsSync: createExistsSync(["C:/Users/me/project", "C:/Windows/explorer.exe"]),
        spawn: recorder.spawn,
      },
    );

    // explorer.exe reads each "/segment" of a forward-slash arg as a switch and
    // falls back to the Documents folder. The path must use backslashes.
    expect(recorder.calls[0]?.command).toBe("C:/Windows/explorer.exe");
    expect(recorder.calls[0]?.args).toEqual(["C:\\Users\\me\\project"]);
    expect(recorder.calls[0]?.options.shell).toBe(false);
  });

  it("opens UNC workspace directories in Explorer using Windows path separators", async () => {
    const recorder = createSpawnRecorder();

    await openEditorTarget(
      { editorId: "explorer", path: "//server/share/project" },
      {
        platform: "win32",
        env: { PATH: "C:/Windows" },
        existsSync: createExistsSync(["//server/share/project", "C:/Windows/explorer.exe"]),
        spawn: recorder.spawn,
      },
    );

    // UNC paths must become \\server\share\... — the leading // is preserved by
    // the app's path normalization and explorer accepts the backslash form.
    expect(recorder.calls[0]?.args).toEqual(["\\\\server\\share\\project"]);
  });

  it("reveals files in Explorer on Windows using Windows path separators", async () => {
    const recorder = createSpawnRecorder();

    await openEditorTarget(
      { editorId: "explorer", path: "C:/repo/src/index.ts", mode: "reveal" },
      {
        platform: "win32",
        env: { PATH: "C:/Windows" },
        existsSync: createExistsSync(["C:/repo/src/index.ts", "C:/Windows/explorer.exe"]),
        spawn: recorder.spawn,
      },
    );

    expect(recorder.calls[0]?.command).toBe("C:/Windows/explorer.exe");
    expect(recorder.calls[0]?.args).toEqual(["/select,", "C:\\repo\\src\\index.ts"]);
    expect(recorder.calls[0]?.options.shell).toBe(false);
  });

  it("keeps Windows shell metacharacters literal for direct executables", async () => {
    const recorder = createSpawnRecorder();

    await openEditorTarget(
      { editorId: "explorer", path: "C:/repo/src/file & calculator.ts", mode: "reveal" },
      {
        platform: "win32",
        env: { PATH: "C:/Windows" },
        existsSync: createExistsSync([
          "C:/repo/src/file & calculator.ts",
          "C:/Windows/explorer.exe",
        ]),
        spawn: recorder.spawn,
      },
    );

    // Separators flip to backslashes; "&" stays literal and the path stays a
    // separate arg token (Node only quotes the path, not the "/select," switch).
    expect(recorder.calls[0]).toMatchObject({
      command: "C:/Windows/explorer.exe",
      args: ["/select,", "C:\\repo\\src\\file & calculator.ts"],
      options: { shell: false },
    });
  });

  it("does not convert separators for editor targets on Windows", async () => {
    const recorder = createSpawnRecorder();

    await openEditorTarget(
      { editorId: "vscode", path: "C:/repo/src/index.ts", cwd: "C:/repo" },
      {
        platform: "win32",
        env: { PATH: "C:/Program Files/Microsoft VS Code/bin" },
        existsSync: createExistsSync([
          "C:/repo/src/index.ts",
          "C:/repo",
          "C:/Program Files/Microsoft VS Code/bin/code.exe",
        ]),
        spawn: recorder.spawn,
      },
    );

    // Editors accept forward slashes; the backslash conversion is Explorer-scoped.
    expect(recorder.calls[0]?.args).toEqual(["C:/repo", "C:/repo/src/index.ts"]);
  });

  it("prefers Windows command shims over extensionless shell launchers", async () => {
    const recorder = createSpawnRecorder();
    const vscodeBin = "C:/Users/me/AppData/Local/Programs/Microsoft VS Code/bin";

    await openEditorTarget(
      {
        editorId: "vscode",
        path: "C:/repo",
      },
      {
        platform: "win32",
        env: { PATH: vscodeBin },
        existsSync: createExistsSync(["C:/repo", `${vscodeBin}/code`, `${vscodeBin}/code.cmd`]),
        spawn: recorder.spawn,
      },
    );

    expect(recorder.calls[0]).toMatchObject({
      command: `"${vscodeBin}/code.cmd"`,
      args: ["C:/repo"],
      options: { shell: true },
    });
  });

  it("keeps the Windows extensionless fallback when no command shim exists", async () => {
    const recorder = createSpawnRecorder();
    const vscodeBin = "C:/Portable/VS Code/bin";

    await openEditorTarget(
      {
        editorId: "vscode",
        path: "C:/repo",
      },
      {
        platform: "win32",
        env: { PATH: vscodeBin },
        existsSync: createExistsSync(["C:/repo", `${vscodeBin}/code`]),
        spawn: recorder.spawn,
      },
    );

    expect(recorder.calls[0]).toMatchObject({
      command: `${vscodeBin}/code`,
      args: ["C:/repo"],
      options: { shell: false },
    });
  });

  it("quotes Windows command-script paths without corrupting metacharacters", async () => {
    const recorder = createSpawnRecorder();

    await openEditorTarget(
      {
        editorId: "vscode",
        path: "C:/repo/src/file & calculator.ts",
        cwd: "C:/repo & workspace",
      },
      {
        platform: "win32",
        env: { PATH: "C:/Program Files/Editors & Tools/bin" },
        existsSync: createExistsSync([
          "C:/repo/src/file & calculator.ts",
          "C:/repo & workspace",
          "C:/Program Files/Editors & Tools/bin/code.cmd",
        ]),
        spawn: recorder.spawn,
      },
    );

    expect(recorder.calls[0]).toMatchObject({
      command: '"C:/Program Files/Editors & Tools/bin/code.cmd"',
      args: ['"C:/repo & workspace"', '"C:/repo/src/file & calculator.ts"'],
      options: { shell: true },
    });
  });

  it("quotes Windows command-script values that contain shell metacharacters", async () => {
    const recorder = createSpawnRecorder();

    await openEditorTarget(
      {
        editorId: "vscode",
        path: "C:/repo/src/file&calculator.ts",
      },
      {
        platform: "win32",
        env: { PATH: "C:/Editors&Tools/bin" },
        existsSync: createExistsSync([
          "C:/repo/src/file&calculator.ts",
          "C:/Editors&Tools/bin/code.cmd",
        ]),
        spawn: recorder.spawn,
      },
    );

    expect(recorder.calls[0]).toMatchObject({
      command: '"C:/Editors&Tools/bin/code.cmd"',
      args: ['"C:/repo/src/file&calculator.ts"'],
      options: { shell: true },
    });
  });

  it("reveals Linux files by opening the containing folder", async () => {
    const recorder = createSpawnRecorder();

    await openEditorTarget(
      { editorId: "file-manager", path: "/home/user/repo/src/index.ts", mode: "reveal" },
      {
        platform: "linux",
        env: { PATH: "/usr/bin" },
        existsSync: createExistsSync(["/home/user/repo/src/index.ts", "/usr/bin/xdg-open"]),
        spawn: recorder.spawn,
      },
    );

    expect(recorder.calls[0]?.args).toEqual(["/home/user/repo/src"]);
  });

  it("ignores reveal mode for editor targets", async () => {
    const recorder = createSpawnRecorder();

    await openEditorTarget(
      { editorId: "vscode", path: "/home/user/repo/src/index.ts", mode: "reveal" },
      {
        platform: "linux",
        env: { PATH: "/usr/bin" },
        existsSync: createExistsSync(["/home/user/repo/src/index.ts", "/usr/bin/code"]),
        spawn: recorder.spawn,
      },
    );

    expect(recorder.calls[0]?.args).toEqual(["/home/user/repo/src/index.ts"]);
  });

  it("opens the workspace folder alongside the file for editor targets", async () => {
    const recorder = createSpawnRecorder();

    await openEditorTarget(
      { editorId: "vscode", path: "/tmp/repo/src/index.ts", cwd: "/tmp/repo" },
      {
        platform: "darwin",
        env: { PATH: "/usr/local/bin" },
        existsSync: createExistsSync([
          "/tmp/repo/src/index.ts",
          "/tmp/repo",
          "/usr/local/bin/code",
        ]),
        spawn: recorder.spawn,
      },
    );

    expect(recorder.calls[0]?.args).toEqual(["/tmp/repo", "/tmp/repo/src/index.ts"]);
  });

  it("can launch future custom script targets by string id", async () => {
    const recorder = createSpawnRecorder();

    await openEditorTarget(
      { editorId: "script:open-in-nvim", path: "/tmp/repo/src/index.ts", cwd: "/tmp/repo" },
      {
        platform: "linux",
        env: { PATH: "/usr/local/bin" },
        existsSync: createExistsSync([
          "/tmp/repo/src/index.ts",
          "/tmp/repo",
          "/usr/local/bin/open-in-nvim",
        ]),
        spawn: recorder.spawn,
        targetDefinitions: [
          {
            id: "script:open-in-nvim",
            label: "Open in Neovim",
            kind: "editor",
            command: "open-in-nvim",
          },
        ],
      },
    );

    expect(recorder.calls[0]).toMatchObject({
      command: "/usr/local/bin/open-in-nvim",
      args: ["/tmp/repo", "/tmp/repo/src/index.ts"],
      options: { shell: false },
    });
  });

  it("does not prepend invalid, equal, relative, or missing cwd values", async () => {
    const inputs = [
      { editorId: "vscode", path: "/tmp/repo", cwd: "/tmp/repo" },
      { editorId: "vscode", path: "/tmp/repo/src/index.ts", cwd: "repo" },
      { editorId: "vscode", path: "/tmp/repo/src/index.ts", cwd: "/tmp/missing" },
    ];

    for (const input of inputs) {
      const recorder = createSpawnRecorder();
      await openEditorTarget(input, {
        platform: "darwin",
        env: { PATH: "/usr/local/bin" },
        existsSync: createExistsSync([
          "/tmp/repo",
          "/tmp/repo/src/index.ts",
          "/usr/local/bin/code",
        ]),
        spawn: recorder.spawn,
      });

      expect(recorder.calls[0]?.args).toEqual([input.path]);
    }
  });

  it("does not prepend cwd for file-manager targets", async () => {
    const recorder = createSpawnRecorder();

    await openEditorTarget(
      { editorId: "finder", path: "/tmp/repo/src", cwd: "/tmp/repo" },
      {
        platform: "darwin",
        env: { PATH: "/usr/bin" },
        existsSync: createExistsSync(["/tmp/repo/src", "/tmp/repo", "/usr/bin/open"]),
        spawn: recorder.spawn,
      },
    );

    expect(recorder.calls[0]?.args).toEqual(["/tmp/repo/src"]);
  });

  it("rejects relative and missing paths", async () => {
    await expect(
      openEditorTarget(
        { editorId: "cursor", path: "repo" },
        { existsSync: () => true, env: { PATH: "/bin" } },
      ),
    ).rejects.toThrow("Editor target path must be an absolute local path");

    await expect(
      openEditorTarget(
        { editorId: "cursor", path: "/tmp/repo" },
        { existsSync: () => false, env: { PATH: "/bin" } },
      ),
    ).rejects.toThrow("Path does not exist: /tmp/repo");
  });

  it("rejects unsupported, unknown, and missing executable targets", async () => {
    await expect(
      openEditorTarget(
        { editorId: "finder", path: "/tmp/repo" },
        { platform: "linux", existsSync: () => true, env: { PATH: "/bin" } },
      ),
    ).rejects.toThrow("Editor target unavailable: Finder");

    await expect(
      openEditorTarget(
        { editorId: "unknown-editor", path: "/tmp/repo" },
        { existsSync: () => true, env: { PATH: "/bin" } },
      ),
    ).rejects.toThrow("Unknown editor target: unknown-editor");

    await expect(
      openEditorTarget(
        { editorId: "vscode", path: "/tmp/repo" },
        { existsSync: (path) => path === "/tmp/repo", env: { PATH: "/bin" } },
      ),
    ).rejects.toThrow("Editor target unavailable: VS Code");
  });

  it("runs list and open behavior through registered IPC handlers", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const ipc = {
      handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
        handlers.set(channel, listener);
      },
    };
    const recorder = createSpawnRecorder();

    registerEditorTargetHandlers({
      ipc,
      dependencies: {
        platform: "darwin",
        env: { PATH: "/usr/local/bin:/usr/bin" },
        existsSync: createExistsSync(["/tmp/repo", "/usr/local/bin/code", "/usr/bin/open"]),
        spawn: recorder.spawn,
      },
    });

    const listHandler = handlers.get("paseo:editor:listTargets");
    const openHandler = handlers.get("paseo:editor:openTarget");
    if (!listHandler || !openHandler) {
      throw new Error("editor IPC handlers were not registered");
    }

    expect(listHandler({})).toEqual([
      { id: "vscode", label: "VS Code", kind: "editor" },
      { id: "finder", label: "Finder", kind: "file-manager" },
    ]);
    await openHandler({}, { editorId: "vscode", path: "/tmp/repo" });
    await expect(openHandler({}, { editorId: "vscode", path: "repo" })).rejects.toThrow(
      "Editor target path must be an absolute local path",
    );

    expect(recorder.calls[0]?.args).toEqual(["/tmp/repo"]);
  });
});
