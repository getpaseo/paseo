import type { EditorTarget, EditorTargetLaunchInput } from "../target.js";

const COMMANDS = ["agy", "antigravity"] as const;

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

export const antigravityTarget: EditorTarget = {
  id: "antigravity",
  async describe(runtime) {
    return {
      id: this.id,
      label: "Antigravity",
      kind: "editor",
      icon: await runtime.loadIcon("antigravity.png"),
    };
  },
  async isInstalled(runtime) {
    return runtime.resolveCommand(COMMANDS) !== null;
  },
  async launch(input, runtime) {
    const command = runtime.resolveCommand(COMMANDS);
    if (!command) throw new Error("Antigravity is not installed");
    await runtime.spawnDetached({ command, args: launchArgs(input) });
  },
};
