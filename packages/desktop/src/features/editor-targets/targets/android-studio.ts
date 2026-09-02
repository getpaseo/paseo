import type { EditorTarget, EditorTargetLaunchInput, EditorTargetRuntime } from "../target.js";

function commands(runtime: EditorTargetRuntime): string[] {
  const candidates = ["studio", "studio64"];
  if (runtime.platform === "darwin") {
    candidates.push("/Applications/Android Studio.app/Contents/MacOS/studio");
    if (runtime.env.HOME) {
      candidates.push(`${runtime.env.HOME}/Applications/Android Studio.app/Contents/MacOS/studio`);
    }
  }
  return candidates;
}

function launchArgs(input: EditorTargetLaunchInput): string[] {
  if (!input.filePath) return [input.workspacePath];
  const args = [input.workspacePath];
  if (input.line) args.push("--line", String(input.line));
  if (input.column) args.push("--column", String(input.column));
  args.push(input.filePath);
  return args;
}

export const androidStudioTarget: EditorTarget = {
  id: "android-studio",
  async describe(runtime) {
    return {
      id: this.id,
      label: "Android Studio",
      kind: "editor",
      icon: await runtime.loadIcon("android-studio.png"),
    };
  },
  async isInstalled(runtime) {
    return runtime.resolveCommand(commands(runtime)) !== null;
  },
  async launch(input, runtime) {
    const command = runtime.resolveCommand(commands(runtime));
    if (!command) throw new Error("Android Studio is not installed");
    await runtime.spawnDetached({ command, args: launchArgs(input) });
  },
};
