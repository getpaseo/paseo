import type { EditorTarget, EditorTargetLaunchInput, EditorTargetRuntime } from "../target.js";

function commands(runtime: EditorTargetRuntime): string[] {
  const candidates = ["code"];
  if (runtime.platform === "darwin") {
    candidates.push("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code");
    if (runtime.env.HOME) {
      candidates.push(
        `${runtime.env.HOME}/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code`,
      );
    }
  }
  if (runtime.platform === "win32") {
    if (runtime.env.LOCALAPPDATA) {
      candidates.push(`${runtime.env.LOCALAPPDATA}/Programs/Microsoft VS Code/bin/code.cmd`);
    }
    if (runtime.env.ProgramFiles) {
      candidates.push(`${runtime.env.ProgramFiles}/Microsoft VS Code/bin/code.cmd`);
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

export const vscodeTarget: EditorTarget = {
  id: "vscode",
  async describe(runtime) {
    return {
      id: this.id,
      label: "VS Code",
      kind: "editor",
      icon: await runtime.loadIcon("vscode.png"),
    };
  },
  async isInstalled(runtime) {
    return (
      runtime.resolveCommand(commands(runtime)) !== null ||
      runtime.hasMacApplication("Visual Studio Code")
    );
  },
  async launch(input, runtime) {
    const command = runtime.resolveCommand(commands(runtime));
    if (command) {
      await runtime.spawnDetached({ command, args: launchArgs(input) });
      return;
    }
    if (runtime.hasMacApplication("Visual Studio Code")) {
      await runtime.openMacApplication({
        applicationName: "Visual Studio Code",
        paths: input.filePath ? [input.workspacePath, input.filePath] : [input.workspacePath],
      });
      return;
    }
    throw new Error("VS Code is not installed");
  },
};
