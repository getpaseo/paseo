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

interface RecordedLaunch {
  command: string;
  args: string[];
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
});
