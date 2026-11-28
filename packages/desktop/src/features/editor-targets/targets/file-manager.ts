import { win32 } from "node:path";
import type { EditorTarget } from "../target.js";

const launchFileManager: EditorTarget["launch"] = async (input, runtime) => {
  const path = input.filePath || input.workspacePath;
  const targetPath = runtime.platform === "win32" ? win32.normalize(path) : path;
  if (input.filePath) {
    runtime.revealPath(targetPath);
    return;
  }
  await runtime.openPath(targetPath);
};

export const finderTarget: EditorTarget = {
  id: "finder",
  async describe(runtime) {
    return {
      id: this.id,
      label: "Finder",
      kind: "file-manager",
      icon: await runtime.loadIcon("finder.png"),
    };
  },
  async isInstalled(runtime) {
    return runtime.platform === "darwin";
  },
  launch: launchFileManager,
};

export const explorerTarget: EditorTarget = {
  id: "explorer",
  async describe() {
    return {
      id: this.id,
      label: "Explorer",
      kind: "file-manager",
      icon: { kind: "symbol", name: "folder" },
    };
  },
  async isInstalled(runtime) {
    return runtime.platform === "win32";
  },
  launch: launchFileManager,
};

export const fileManagerTarget: EditorTarget = {
  id: "file-manager",
  async describe() {
    return {
      id: this.id,
      label: "Files",
      kind: "file-manager",
      icon: { kind: "symbol", name: "folder" },
    };
  },
  async isInstalled(runtime) {
    return runtime.platform !== "darwin" && runtime.platform !== "win32";
  },
  launch: launchFileManager,
};
