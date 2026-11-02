import type { EditorTarget } from "../target.js";

const COMMANDS = ["goland", "goland64"] as const;

export const golandTarget: EditorTarget = {
  id: "goland",
  async describe(runtime) {
    return {
      id: this.id,
      label: "GoLand",
      kind: "editor",
      icon: await runtime.loadIcon("goland.png"),
    };
  },
  async isInstalled(runtime) {
    return runtime.resolveCommand(COMMANDS) !== null;
  },
  async launch(input, runtime) {
    const command = runtime.resolveCommand(COMMANDS);
    if (!command) throw new Error("GoLand is not installed");
    if (!input.filePath) return runtime.spawnDetached({ command, args: [input.workspacePath] });
    const args: string[] = [];
    if (input.line) args.push("--line", String(input.line));
    if (input.column) args.push("--column", String(input.column));
    args.push(input.workspacePath, input.filePath);
    await runtime.spawnDetached({ command, args });
  },
};
