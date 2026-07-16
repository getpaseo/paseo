import type { EditorTarget } from "../target.js";

const COMMANDS = ["rubymine", "rubymine64"] as const;

export const rubymineTarget: EditorTarget = {
  id: "rubymine",
  async describe() {
    return {
      id: this.id,
      label: "RubyMine",
      kind: "editor",
      icon: { kind: "symbol", name: "terminal" },
    };
  },
  async isInstalled(runtime) {
    return runtime.resolveCommand(COMMANDS) !== null;
  },
  async launch(input, runtime) {
    const command = runtime.resolveCommand(COMMANDS);
    if (!command) throw new Error("RubyMine is not installed");
    if (!input.filePath) return runtime.spawnDetached({ command, args: [input.workspacePath] });
    const args: string[] = [];
    if (input.line) args.push("--line", String(input.line));
    if (input.column) args.push("--column", String(input.column));
    args.push(input.workspacePath, input.filePath);
    await runtime.spawnDetached({ command, args });
  },
};
