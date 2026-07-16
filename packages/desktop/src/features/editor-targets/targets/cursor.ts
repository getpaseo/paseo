import type { EditorTarget, EditorTargetLaunchInput, EditorTargetRuntime } from "../target.js";

function commands(runtime: EditorTargetRuntime): string[] {
  const candidates = ["cursor"];
  if (runtime.platform === "darwin") {
    candidates.push("/Applications/Cursor.app/Contents/Resources/app/bin/cursor");
    if (runtime.env.HOME) {
      candidates.push(
        `${runtime.env.HOME}/Applications/Cursor.app/Contents/Resources/app/bin/cursor`,
      );
    }
  }
  if (runtime.platform === "win32") {
    if (runtime.env.LOCALAPPDATA) {
      candidates.push(`${runtime.env.LOCALAPPDATA}/Programs/cursor/resources/app/bin/cursor.cmd`);
      candidates.push(`${runtime.env.LOCALAPPDATA}/Programs/cursor/Cursor.exe`);
    }
    if (runtime.env.ProgramFiles) {
      candidates.push(`${runtime.env.ProgramFiles}/Cursor/resources/app/bin/cursor.cmd`);
      candidates.push(`${runtime.env.ProgramFiles}/Cursor/Cursor.exe`);
    }
  }
  return candidates;
}

function location(input: EditorTargetLaunchInput): string {
  if (!input.line) return input.filePath!;
  return input.column
    ? `${input.filePath}:${input.line}:${input.column}`
    : `${input.filePath}:${input.line}`;
}

function launchArgs(input: EditorTargetLaunchInput): string[] {
  if (!input.filePath) return [input.workspacePath];
  if (!input.line) return [input.workspacePath, input.filePath];
  return [input.workspacePath, "--goto", location(input)];
}

export const cursorTarget: EditorTarget = {
  id: "cursor",
  async describe(runtime) {
    return {
      id: this.id,
      label: "Cursor",
      kind: "editor",
      icon: await runtime.loadIcon("cursor.png"),
    };
  },
  async isInstalled(runtime) {
    return (
      runtime.resolveCommand(commands(runtime)) !== null || runtime.hasMacApplication("Cursor")
    );
  },
  async launch(input, runtime) {
    const command = runtime.resolveCommand(commands(runtime));
    if (command) {
      await runtime.spawnDetached({ command, args: launchArgs(input) });
      return;
    }
    if (runtime.hasMacApplication("Cursor")) {
      await runtime.openMacApplication({
        applicationName: "Cursor",
        paths: input.filePath ? [input.workspacePath, input.filePath] : [input.workspacePath],
      });
      return;
    }
    throw new Error("Cursor is not installed");
  },
};
