import type { EditorTarget } from "../target.js";

const COMMANDS = ["webstorm", "webstorm64"] as const;

export const webstormTarget: EditorTarget = {
  id: "webstorm",
  async describe(runtime) {
    return {
      id: this.id,
      label: "WebStorm",
      kind: "editor",
      icon: await runtime.loadIcon("webstorm.png"),
    };
  },
  async isInstalled(runtime) {
    return runtime.resolveCommand(COMMANDS) !== null;
  },
  async launch(input, runtime) {
    const command = runtime.resolveCommand(COMMANDS);
    if (!command) throw new Error("WebStorm is not installed");
    if (!input.filePath) {
      await runtime.spawnDetached({ command, args: [input.workspacePath] });
      return;
    }
    const args: string[] = [];
    if (input.line) args.push("--line", String(input.line));
    if (input.column) args.push("--column", String(input.column));
    args.push(input.workspacePath, input.filePath);
    await runtime.spawnDetached({ command, args });
  },
};
