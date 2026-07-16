import type { EditorTarget } from "../target.js";

export const fileManagerTarget: EditorTarget = {
  id: "file-manager",
  async describe(runtime) {
    if (runtime.platform === "darwin") {
      return {
        id: this.id,
        label: "Finder",
        kind: "file-manager",
        icon: await runtime.loadIcon("finder.png"),
      };
    }
    if (runtime.platform === "win32") {
      return {
        id: this.id,
        label: "Explorer",
        kind: "file-manager",
        icon: { kind: "symbol", name: "folder" },
      };
    }
    return {
      id: this.id,
      label: "Files",
      kind: "file-manager",
      icon: { kind: "symbol", name: "folder" },
    };
  },
  async isInstalled() {
    return true;
  },
  async launch(input, runtime) {
    if (input.filePath) {
      runtime.revealPath(input.filePath);
      return;
    }
    await runtime.openPath(input.workspacePath);
  },
};
