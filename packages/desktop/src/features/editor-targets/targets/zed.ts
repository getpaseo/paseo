import type { EditorTarget, EditorTargetLaunchInput } from "../target.js";

const COMMANDS = ["zed", "zeditor"] as const;

function location(input: EditorTargetLaunchInput): string {
  if (!input.line) return input.filePath!;
  return input.column
    ? `${input.filePath}:${input.line}:${input.column}`
    : `${input.filePath}:${input.line}`;
}

export const zedTarget: EditorTarget = {
  id: "zed",
  async describe(runtime) {
    return { id: this.id, label: "Zed", kind: "editor", icon: await runtime.loadIcon("zed.png") };
  },
  async isInstalled(runtime) {
    return runtime.resolveCommand(COMMANDS) !== null || runtime.hasMacApplication("Zed");
  },
  async launch(input, runtime) {
    const command = runtime.resolveCommand(COMMANDS);
    if (command) {
      await runtime.spawnDetached({
        command,
        args: input.filePath ? [input.workspacePath, location(input)] : [input.workspacePath],
      });
      return;
    }
    if (runtime.hasMacApplication("Zed")) {
      await runtime.openMacApplication({
        applicationName: "Zed",
        paths: input.filePath ? [input.workspacePath, input.filePath] : [input.workspacePath],
      });
      return;
    }
    throw new Error("Zed is not installed");
  },
};
