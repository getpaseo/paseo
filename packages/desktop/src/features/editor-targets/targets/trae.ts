import type { EditorTarget, EditorTargetLaunchInput } from "../target.js";

const COMMANDS = ["trae"] as const;

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

export const traeTarget: EditorTarget = {
  id: "trae",
  async describe() {
    return {
      id: this.id,
      label: "Trae",
      kind: "editor",
      icon: { kind: "symbol", name: "terminal" },
    };
  },
  async isInstalled(runtime) {
    return runtime.resolveCommand(COMMANDS) !== null;
  },
  async launch(input, runtime) {
    const command = runtime.resolveCommand(COMMANDS);
    if (!command) throw new Error("Trae is not installed");
    await runtime.spawnDetached({ command, args: launchArgs(input) });
  },
};
