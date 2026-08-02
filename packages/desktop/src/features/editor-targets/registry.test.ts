import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { listAvailableEditorTargets, openEditorTarget } from "./registry.js";
import type { EditorTargetIcon, EditorTargetRuntime } from "./target.js";
import { cursorTarget } from "./targets/cursor.js";
import { explorerTarget, fileManagerTarget, finderTarget } from "./targets/file-manager.js";
import { intellijIdeaTarget } from "./targets/intellij-idea.js";
import { pycharmTarget } from "./targets/pycharm.js";
import { vscodeTarget } from "./targets/vscode.js";
import { webstormTarget } from "./targets/webstorm.js";
import { zedTarget } from "./targets/zed.js";
import {
  alacrittyTerminalTarget,
  ghosttyTerminalTarget,
  gnomeConsoleTarget,
  gnomeTerminalTarget,
  itermTerminalTarget,
  kittyTerminalTarget,
  konsoleTerminalTarget,
  linuxDefaultTerminalTarget,
  macTerminalTarget,
  ptyxisTerminalTarget,
  tilixTerminalTarget,
  warpTerminalTarget,
  weztermTerminalTarget,
  windowsTerminalTarget,
  xfceTerminalTarget,
} from "./targets/terminal.js";

interface RecordedLaunch {
  command: string;
  args: string[];
}

class FakeEditorTargets implements EditorTargetRuntime {
  readonly launches: RecordedLaunch[] = [];
  readonly openedPaths: string[] = [];
  readonly revealedPaths: string[] = [];
  readonly openedExternalUrls: string[] = [];
  readonly openedMacApplications: Array<{
    applicationName: string;
    paths: string[];
  }> = [];

  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  private readonly paths = new Set<string>();
  private readonly commands = new Map<string, string>();
  private readonly macApplications = new Set<string>();
  private readonly externalUrlProtocols = new Set<string>();

  constructor(platform: NodeJS.Platform = "linux", env: NodeJS.ProcessEnv = {}) {
    this.platform = platform;
    this.env = env;
  }

  addPath(targetPath: string): void {
    this.paths.add(targetPath);
  }

  installCommand(command: string, executable = `/bin/${command}`): void {
    this.commands.set(command, executable);
  }

  installMacApplication(applicationName: string): void {
    this.macApplications.add(applicationName);
  }

  installExternalUrlProtocol(protocol: string): void {
    this.externalUrlProtocols.add(protocol);
  }

  pathExists(targetPath: string): boolean {
    return this.paths.has(targetPath);
  }

  isAbsolutePath(targetPath: string): boolean {
    return targetPath.startsWith("/") || /^[A-Z]:\//u.test(targetPath);
  }

  resolveCommand(commands: readonly string[]): string | null {
    for (const command of commands) {
      const executable = this.commands.get(command);
      if (executable) return executable;
    }
    return null;
  }

  async spawnDetached(input: { command: string; args: readonly string[] }): Promise<void> {
    this.launches.push({ command: input.command, args: [...input.args] });
  }

  async openPath(targetPath: string): Promise<void> {
    this.openedPaths.push(targetPath);
  }

  async openExternalUrl(url: string): Promise<void> {
    this.openedExternalUrls.push(url);
  }

  hasExternalUrlHandler(url: string): boolean {
    return this.externalUrlProtocols.has(new URL(url).protocol);
  }

  revealPath(targetPath: string): void {
    this.revealedPaths.push(targetPath);
  }

  async loadIcon(fileName: string): Promise<EditorTargetIcon> {
    return { kind: "image", dataUrl: `data:image/png;base64,${fileName}` };
  }

  hasMacApplication(applicationName: string): boolean {
    return this.macApplications.has(applicationName);
  }

  async openMacApplication(input: {
    applicationName: string;
    paths: readonly string[];
  }): Promise<void> {
    this.openedMacApplications.push({
      applicationName: input.applicationName,
      paths: [...input.paths],
    });
  }
}

describe("editor target registry", () => {
  it("lists installed target implementations in registration order", async () => {
    const runtime = new FakeEditorTargets();
    runtime.installCommand("code");
    runtime.installCommand("webstorm");

    const targets = await listAvailableEditorTargets(runtime, [
      cursorTarget,
      vscodeTarget,
      webstormTarget,
      fileManagerTarget,
    ]);

    expect(targets).toEqual([
      {
        id: "vscode",
        label: "VS Code",
        kind: "editor",
        icon: { kind: "image", dataUrl: "data:image/png;base64,vscode.png" },
      },
      {
        id: "webstorm",
        label: "WebStorm",
        kind: "editor",
        icon: { kind: "image", dataUrl: "data:image/png;base64,webstorm.png" },
      },
      {
        id: "file-manager",
        label: "Files",
        kind: "file-manager",
        icon: { kind: "symbol", name: "folder" },
      },
    ]);
  });

  it("opens a selected file at its position through the target implementation", async () => {
    const runtime = new FakeEditorTargets();
    runtime.installCommand("code");
    runtime.addPath("/repo");
    runtime.addPath("/repo/src/app.ts");

    await openEditorTarget(
      {
        editorId: "vscode",
        workspacePath: "/repo",
        filePath: "/repo/src/app.ts",
        line: 12,
        column: 4,
      },
      runtime,
      [vscodeTarget],
    );

    expect(runtime.launches).toEqual([
      {
        command: "/bin/code",
        args: ["/repo", "--goto", "/repo/src/app.ts:12:4"],
      },
    ]);
  });

  it("lets each target choose its own command and arguments", async () => {
    const runtime = new FakeEditorTargets();
    runtime.installCommand("zeditor");
    runtime.installCommand("webstorm");
    runtime.installCommand("idea");

    await zedTarget.launch(
      { workspacePath: "/repo", filePath: "/repo/src/app.ts", line: 7, column: 2 },
      runtime,
    );
    await webstormTarget.launch(
      { workspacePath: "/repo", filePath: "/repo/src/app.ts", line: 7, column: 2 },
      runtime,
    );
    await intellijIdeaTarget.launch({ workspacePath: "/repo" }, runtime);

    expect(runtime.launches).toEqual([
      { command: "/bin/zeditor", args: ["/repo", "/repo/src/app.ts:7:2"] },
      {
        command: "/bin/webstorm",
        args: ["--line", "7", "--column", "2", "/repo", "/repo/src/app.ts"],
      },
      { command: "/bin/idea", args: ["/repo"] },
    ]);
  });

  it("recognizes Windows 64-bit project IDE launchers", async () => {
    const runtime = new FakeEditorTargets("win32");
    runtime.installCommand("pycharm64", "C:/Tools/PyCharm/bin/pycharm64.exe");

    expect(await pycharmTarget.isInstalled(runtime)).toBe(true);
    await pycharmTarget.launch(
      { workspacePath: "C:/repo", filePath: "C:/repo/src/app.py", line: 6 },
      runtime,
    );

    expect(runtime.launches).toEqual([
      {
        command: "C:/Tools/PyCharm/bin/pycharm64.exe",
        args: ["--line", "6", "C:/repo", "C:/repo/src/app.py"],
      },
    ]);
  });

  it("detects and launches the macOS application when the command is absent", async () => {
    const runtime = new FakeEditorTargets("darwin");
    runtime.installMacApplication("Cursor");

    expect(await cursorTarget.isInstalled(runtime)).toBe(true);
    await cursorTarget.launch({ workspacePath: "/repo", filePath: "/repo/src/app.ts" }, runtime);

    expect(runtime.openedMacApplications).toEqual([
      {
        applicationName: "Cursor",
        paths: ["/repo", "/repo/src/app.ts"],
      },
    ]);
  });

  it("uses Cursor's bundled macOS command so file positions survive application detection", async () => {
    const runtime = new FakeEditorTargets("darwin");
    const bundledCommand = "/Applications/Cursor.app/Contents/Resources/app/bin/cursor";
    runtime.installCommand(bundledCommand, bundledCommand);

    expect(await cursorTarget.isInstalled(runtime)).toBe(true);
    await cursorTarget.launch(
      { workspacePath: "/repo", filePath: "/repo/src/app.ts", line: 18, column: 3 },
      runtime,
    );

    expect(runtime.launches).toEqual([
      {
        command: bundledCommand,
        args: ["/repo", "--goto", "/repo/src/app.ts:18:3"],
      },
    ]);
  });

  it("detects Cursor's installed Windows command when it is absent from PATH", async () => {
    const runtime = new FakeEditorTargets("win32", {
      LOCALAPPDATA: "C:/Users/me/AppData/Local",
    });
    const installedCommand =
      "C:/Users/me/AppData/Local/Programs/cursor/resources/app/bin/cursor.cmd";
    runtime.installCommand(installedCommand, installedCommand);

    expect(await cursorTarget.isInstalled(runtime)).toBe(true);
    await cursorTarget.launch(
      { workspacePath: "C:/repo", filePath: "C:/repo/src/app.ts", line: 9 },
      runtime,
    );

    expect(runtime.launches).toEqual([
      {
        command: installedCommand,
        args: ["C:/repo", "--goto", "C:/repo/src/app.ts:9"],
      },
    ]);
  });

  it("delegates folder opening and file reveal to the system file manager", async () => {
    const runtime = new FakeEditorTargets("win32");

    expect(await explorerTarget.describe(runtime)).toEqual({
      id: "explorer",
      label: "Explorer",
      kind: "file-manager",
      icon: { kind: "symbol", name: "folder" },
    });
    await explorerTarget.launch({ workspacePath: "C:/repo" }, runtime);
    await explorerTarget.launch(
      { workspacePath: "C:/repo", filePath: "C:/repo/src/app.ts" },
      runtime,
    );

    expect(runtime.openedPaths).toEqual(["C:/repo"]);
    expect(runtime.revealedPaths).toEqual(["C:/repo/src/app.ts"]);
  });

  it("keeps the platform file-manager ids used by stored preferences", async () => {
    const macTargets = await listAvailableEditorTargets(new FakeEditorTargets("darwin"), [
      finderTarget,
      explorerTarget,
      fileManagerTarget,
    ]);
    const windowsTargets = await listAvailableEditorTargets(new FakeEditorTargets("win32"), [
      finderTarget,
      explorerTarget,
      fileManagerTarget,
    ]);

    expect(macTargets.map((target) => target.id)).toEqual(["finder"]);
    expect(windowsTargets.map((target) => target.id)).toEqual(["explorer"]);
  });

  it("uses bundled brand icons for named terminals and a symbol for the Linux default", async () => {
    const runtime = new FakeEditorTargets();
    const targetsAndIcons = [
      [ghosttyTerminalTarget, "ghostty.png"],
      [warpTerminalTarget, "warp.png"],
      [weztermTerminalTarget, "wezterm.png"],
      [kittyTerminalTarget, "kitty.png"],
      [alacrittyTerminalTarget, "alacritty.png"],
      [itermTerminalTarget, "iterm2.png"],
      [macTerminalTarget, "macos-terminal.png"],
      [windowsTerminalTarget, "windows-terminal.png"],
      [gnomeTerminalTarget, "gnome-terminal.png"],
      [gnomeConsoleTarget, "gnome-console.png"],
      [ptyxisTerminalTarget, "ptyxis.png"],
      [konsoleTerminalTarget, "konsole.png"],
      [tilixTerminalTarget, "tilix.png"],
      [xfceTerminalTarget, "xfce-terminal.png"],
    ] as const;

    for (const [target, iconFileName] of targetsAndIcons) {
      expect((await target.describe(runtime)).icon).toEqual({
        kind: "image",
        dataUrl: `data:image/png;base64,${iconFileName}`,
      });
    }
    expect((await linuxDefaultTerminalTarget.describe(runtime)).icon).toEqual({
      kind: "symbol",
      name: "terminal",
    });

    for (const [, iconFileName] of targetsAndIcons) {
      const bytes = await readFile(
        path.resolve(__dirname, "../../../assets/editor-targets", iconFileName),
      );
      expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
      expect(bytes.readUInt32BE(16)).toBe(64);
      expect(bytes.readUInt32BE(20)).toBe(64);
    }
  });

  it("detects macOS terminals and opens their workspace through the application", async () => {
    const runtime = new FakeEditorTargets("darwin");
    runtime.installMacApplication("Ghostty");
    runtime.installMacApplication("iTerm");

    const targets = await listAvailableEditorTargets(runtime, [
      ghosttyTerminalTarget,
      itermTerminalTarget,
      macTerminalTarget,
    ]);
    expect(targets.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: "terminal:ghostty", kind: "terminal" },
      { id: "terminal:iterm2", kind: "terminal" },
      { id: "terminal:macos", kind: "terminal" },
    ]);

    await ghosttyTerminalTarget.launch({ workspacePath: "/repo with spaces" }, runtime);
    expect(runtime.openedMacApplications).toEqual([
      { applicationName: "Ghostty", paths: ["/repo with spaces"] },
    ]);
  });

  it("launches installed Linux terminals with their working-directory contracts", async () => {
    const runtime = new FakeEditorTargets("linux");
    runtime.installCommand("ghostty");
    runtime.installCommand("wezterm");
    runtime.installCommand("kitty");
    runtime.installCommand("alacritty");
    runtime.installCommand("gnome-terminal");
    runtime.installCommand("kgx");
    runtime.installCommand("ptyxis");
    runtime.installCommand("konsole");
    runtime.installCommand("tilix");
    runtime.installCommand("xfce4-terminal");
    runtime.installCommand("xdg-terminal-exec");

    const targets = await listAvailableEditorTargets(runtime, [
      ghosttyTerminalTarget,
      weztermTerminalTarget,
      kittyTerminalTarget,
      alacrittyTerminalTarget,
      gnomeTerminalTarget,
      gnomeConsoleTarget,
      ptyxisTerminalTarget,
      konsoleTerminalTarget,
      tilixTerminalTarget,
      xfceTerminalTarget,
      linuxDefaultTerminalTarget,
    ]);
    expect(targets.map((target) => target.id)).toEqual([
      "terminal:ghostty",
      "terminal:wezterm",
      "terminal:kitty",
      "terminal:alacritty",
      "terminal:gnome-terminal",
      "terminal:gnome-console",
      "terminal:ptyxis",
      "terminal:konsole",
      "terminal:tilix",
      "terminal:xfce",
      "terminal:linux-default",
    ]);

    await ghosttyTerminalTarget.launch({ workspacePath: "/repo's worktree" }, runtime);
    await weztermTerminalTarget.launch({ workspacePath: "/repo's worktree" }, runtime);
    await kittyTerminalTarget.launch({ workspacePath: "/repo's worktree" }, runtime);
    await alacrittyTerminalTarget.launch({ workspacePath: "/repo's worktree" }, runtime);
    await gnomeTerminalTarget.launch({ workspacePath: "/repo's worktree" }, runtime);
    await gnomeConsoleTarget.launch({ workspacePath: "/repo's worktree" }, runtime);
    await ptyxisTerminalTarget.launch({ workspacePath: "/repo's worktree" }, runtime);
    await konsoleTerminalTarget.launch({ workspacePath: "/repo's worktree" }, runtime);
    await tilixTerminalTarget.launch({ workspacePath: "/repo's worktree" }, runtime);
    await xfceTerminalTarget.launch({ workspacePath: "/repo's worktree" }, runtime);
    await linuxDefaultTerminalTarget.launch({ workspacePath: "/repo's worktree" }, runtime);
    expect(runtime.launches).toEqual([
      {
        command: "/bin/ghostty",
        args: ["+new-window", "--working-directory=/repo's worktree"],
      },
      { command: "/bin/wezterm", args: ["start", "--cwd", "/repo's worktree"] },
      { command: "/bin/kitty", args: ["--directory", "/repo's worktree"] },
      { command: "/bin/alacritty", args: ["--working-directory", "/repo's worktree"] },
      { command: "/bin/gnome-terminal", args: ["--working-directory=/repo's worktree"] },
      { command: "/bin/kgx", args: ["--working-directory=/repo's worktree"] },
      {
        command: "/bin/ptyxis",
        args: ["--new-window", "--working-directory", "/repo's worktree"],
      },
      { command: "/bin/konsole", args: ["--workdir", "/repo's worktree"] },
      { command: "/bin/tilix", args: ["--working-directory=/repo's worktree"] },
      { command: "/bin/xfce4-terminal", args: ["--working-directory=/repo's worktree"] },
      { command: "/bin/xdg-terminal-exec", args: ["--dir=/repo's worktree"] },
    ]);
  });

  it("detects Windows Terminal and cross-platform Windows terminals", async () => {
    const runtime = new FakeEditorTargets("win32");
    runtime.installCommand("wt.exe");
    runtime.installCommand("wezterm.exe");
    runtime.installCommand("alacritty.exe");
    runtime.installExternalUrlProtocol("warp:");

    const targets = await listAvailableEditorTargets(runtime, [
      windowsTerminalTarget,
      weztermTerminalTarget,
      alacrittyTerminalTarget,
      warpTerminalTarget,
      ghosttyTerminalTarget,
      kittyTerminalTarget,
    ]);
    expect(targets.map((target) => target.id)).toEqual([
      "terminal:windows-terminal",
      "terminal:wezterm",
      "terminal:alacritty",
      "terminal:warp",
    ]);

    await windowsTerminalTarget.launch({ workspacePath: "C:/repo & worktree" }, runtime);
    await warpTerminalTarget.launch({ workspacePath: "C:/repo & worktree" }, runtime);
    expect(runtime.launches).toEqual([
      { command: "/bin/wt.exe", args: ["-d", "C:/repo & worktree"] },
    ]);
    expect(runtime.openedExternalUrls).toEqual([
      "warp://action/new_window?path=C%3A%2Frepo+%26+worktree",
    ]);
  });
});
