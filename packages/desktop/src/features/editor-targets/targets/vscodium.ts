import type { EditorTarget, EditorTargetLaunchInput, EditorTargetRuntime } from "../target.js";

function commands(runtime: EditorTargetRuntime): string[] {
  const candidates = ["codium"];
  if (runtime.platform === "darwin") {
    candidates.push("/Applications/VSCodium.app/Contents/Resources/app/bin/codium");
    if (runtime.env.HOME) {
      candidates.push(
        `${runtime.env.HOME}/Applications/VSCodium.app/Contents/Resources/app/bin/codium`,
      );
    }
  }
  if (runtime.platform === "win32") {
    if (runtime.env.LOCALAPPDATA) {
      candidates.push(`${runtime.env.LOCALAPPDATA}/Programs/VSCodium/bin/codium.cmd`);
    }
    if (runtime.env.ProgramFiles) {
      candidates.push(`${runtime.env.ProgramFiles}/VSCodium/bin/codium.cmd`);
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

export const vscodiumTarget: EditorTarget = {
  id: "vscodium",
  async describe() {
    return {
      id: this.id,
      label: "VSCodium",
      kind: "editor",
      icon: { kind: "symbol", name: "terminal" },
    };
  },
  async isInstalled(runtime) {
    return (
      runtime.resolveCommand(commands(runtime)) !== null || runtime.hasMacApplication("VSCodium")
    );
  },
  async launch(input, runtime) {
    const command = runtime.resolveCommand(commands(runtime));
    if (command) {
      await runtime.spawnDetached({ command, args: launchArgs(input) });
      return;
    }
    if (runtime.hasMacApplication("VSCodium")) {
      await runtime.openMacApplication({
        applicationName: "VSCodium",
        paths: input.filePath ? [input.workspacePath, input.filePath] : [input.workspacePath],
      });
      return;
    }
    throw new Error("VSCodium is not installed");
  },
};
