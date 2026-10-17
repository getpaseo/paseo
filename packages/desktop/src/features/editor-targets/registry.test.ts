import { describe, expect, it } from "vitest";

import { listAvailableEditorTargets, openEditorTarget } from "./registry.js";
import type {
  EditorTargetDirectoryEntry,
  EditorTargetIcon,
  EditorTargetRuntime,
} from "./target.js";
import { cursorTarget } from "./targets/cursor.js";
import { explorerTarget, fileManagerTarget, finderTarget } from "./targets/file-manager.js";
import { intellijIdeaTarget } from "./targets/intellij-idea.js";
import { pycharmTarget } from "./targets/pycharm.js";
import { vscodeTarget } from "./targets/vscode.js";
import { webstormTarget } from "./targets/webstorm.js";
import { xcodeTarget } from "./targets/xcode.js";
import { zedTarget } from "./targets/zed.js";

interface RecordedLaunch {
  command: string;
  args: string[];
}

function testDirectoryEntry(name: string): EditorTargetDirectoryEntry {
  if (name === "Package.swift") return { name, kind: "file" };
  if (name.endsWith(".xcodeproj") || name.endsWith(".xcworkspace")) {
    return { name, kind: "directory" };
  }
  return { name, kind: "other" };
}

class FakeEditorTargets implements EditorTargetRuntime {
  readonly launches: RecordedLaunch[] = [];
  readonly openedPaths: string[] = [];
  readonly revealedPaths: string[] = [];
  readonly openedMacApplications: Array<{
    applicationName: string;
    paths: string[];
  }> = [];

  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  private readonly paths = new Set<string>();
  private readonly commands = new Map<string, string>();
  private readonly macApplications = new Set<string>();
  private readonly directories = new Map<string, EditorTargetDirectoryEntry[]>();

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

  addDirectory(targetPath: string, entries: readonly string[]): void {
    this.paths.add(targetPath);
    this.directories.set(targetPath, entries.map(testDirectoryEntry));
  }

  addDirectoryEntries(targetPath: string, entries: readonly EditorTargetDirectoryEntry[]): void {
    this.paths.add(targetPath);
    this.directories.set(targetPath, [...entries]);
  }

  listDirectory(targetPath: string): EditorTargetDirectoryEntry[] {
    return this.directories.get(targetPath) ?? [];
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

  revealPath(targetPath: string): void {
    this.revealedPaths.push(targetPath);
  }

  async loadIcon(fileName: string): Promise<EditorTargetIcon> {
    return { kind: "image", dataUrl: `data:image/png;base64,${fileName}` };
  }

  hasMacApplication(applicationName: string): boolean {
    return this.macApplications.has(applicationName);
  }

  getMacApplicationBundle(applicationName: string): string | null {
    return this.hasMacApplication(applicationName) ? `/Applications/${applicationName}.app` : null;
  }

  async openMacApplication(input: {
    applicationName: string;
    applicationPath?: string;
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

  it("lists and opens Android Studio through its bundled macOS launcher", async () => {
    const runtime = new FakeEditorTargets("darwin", { HOME: "/Users/me" });
    const bundledCommand = "/Users/me/Applications/Android Studio.app/Contents/MacOS/studio";
    runtime.installCommand(bundledCommand, bundledCommand);
    runtime.addPath("/repo");
    runtime.addPath("/repo/app/src/main/MainActivity.kt");

    const targets = await listAvailableEditorTargets(runtime);

    expect(targets).toContainEqual({
      id: "android-studio",
      label: "Android Studio",
      kind: "editor",
      icon: { kind: "image", dataUrl: "data:image/png;base64,android-studio.png" },
    });

    await openEditorTarget(
      {
        editorId: "android-studio",
        workspacePath: "/repo",
        filePath: "/repo/app/src/main/MainActivity.kt",
        line: 18,
        column: 3,
      },
      runtime,
    );

    expect(runtime.launches).toEqual([
      {
        command: bundledCommand,
        args: ["/repo", "--line", "18", "--column", "3", "/repo/app/src/main/MainActivity.kt"],
      },
    ]);
  });

  it("lists Xcode only for workspaces that hold something Xcode can open", async () => {
    const runtime = new FakeEditorTargets("darwin");
    runtime.installMacApplication("Xcode");
    runtime.addDirectory("/repo/ios-app", ["ios-app.xcodeproj", "Sources"]);
    runtime.addDirectory("/repo/web-app", ["package.json", "src"]);

    const iosTargets = await listAvailableEditorTargets(runtime, [xcodeTarget], {
      workspacePath: "/repo/ios-app",
    });
    const webTargets = await listAvailableEditorTargets(runtime, [xcodeTarget], {
      workspacePath: "/repo/web-app",
    });
    const unscopedTargets = await listAvailableEditorTargets(runtime, [xcodeTarget]);

    expect(iosTargets).toEqual([
      {
        id: "xcode",
        label: "Xcode",
        kind: "editor",
        icon: { kind: "image", dataUrl: "data:image/png;base64,xcode.png" },
        scope: "workspace",
      },
    ]);
    expect(webTargets).toEqual([]);
    expect(unscopedTargets).toEqual([]);
  });

  it("does not mistake similarly named files and directories for Xcode documents", async () => {
    const runtime = new FakeEditorTargets("darwin");
    runtime.installMacApplication("Xcode");
    runtime.addDirectoryEntries("/repo/not-an-xcode-project", [
      { name: "Notes.xcodeproj", kind: "file" },
      { name: "App.xcworkspace", kind: "file" },
      { name: "Package.swift", kind: "directory" },
    ]);

    await expect(
      listAvailableEditorTargets(runtime, [xcodeTarget], {
        workspacePath: "/repo/not-an-xcode-project",
      }),
    ).resolves.toEqual([]);
  });

  it("hands Xcode the umbrella workspace and reveals the requested file inside it", async () => {
    const runtime = new FakeEditorTargets("darwin");
    runtime.installMacApplication("Xcode");
    runtime.addDirectory("/repo/Tickets", [
      "Package.swift",
      "Widgets.xcworkspace",
      "Tickets.xcworkspace",
      "Tickets.xcodeproj",
    ]);
    runtime.addPath("/repo/Tickets/Sources/App.swift");

    await openEditorTarget(
      {
        editorId: "xcode",
        workspacePath: "/repo/Tickets",
        filePath: "/repo/Tickets/Sources/App.swift",
        line: 12,
      },
      runtime,
      [xcodeTarget],
    );

    expect(runtime.openedMacApplications).toEqual([
      {
        applicationName: "Xcode",
        paths: ["/repo/Tickets/Tickets.xcworkspace", "/repo/Tickets/Sources/App.swift"],
      },
    ]);
  });

  it("falls back from Xcode workspaces to projects to Swift packages", async () => {
    const runtime = new FakeEditorTargets("darwin");
    runtime.installMacApplication("Xcode");
    runtime.addDirectory("/repo/project-only", ["Beta.xcodeproj", "Alpha.xcodeproj"]);
    runtime.addDirectory("/repo/package-only", ["Package.swift", "Sources"]);

    await xcodeTarget.launch({ workspacePath: "/repo/project-only" }, runtime);
    await xcodeTarget.launch({ workspacePath: "/repo/package-only" }, runtime);

    expect(runtime.openedMacApplications.map((entry) => entry.paths)).toEqual([
      ["/repo/project-only/Alpha.xcodeproj"],
      ["/repo/package-only/Package.swift"],
    ]);
  });

  it("refuses to launch Xcode for a directory it cannot open", async () => {
    const runtime = new FakeEditorTargets("darwin");
    runtime.installMacApplication("Xcode");
    runtime.addDirectory("/repo/web-app", ["package.json"]);

    await expect(xcodeTarget.launch({ workspacePath: "/repo/web-app" }, runtime)).rejects.toThrow(
      /No Xcode project/u,
    );
    expect(runtime.openedMacApplications).toEqual([]);
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
});
