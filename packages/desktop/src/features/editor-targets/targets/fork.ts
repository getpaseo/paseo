import type { EditorTarget } from "../target.js";

// Fork (https://git-fork.com) is a macOS/Windows Git client. It opens a
// *repository*, not a file, so we always hand it the workspace root and ignore
// any filePath. Launch goes through the macOS application (`open -a Fork <repo>`)
// rather than a CLI: Fork's `fork` command-line helper is opt-in (the user has
// to install it) and is cwd-based, whereas the app bundle is always present once
// Fork is installed and reliably opens the repo as a tab. Windows support can
// follow once its launcher can be verified.
export const forkTarget: EditorTarget = {
  id: "fork",
  async describe(runtime) {
    return {
      id: this.id,
      label: "Fork",
      kind: "editor",
      icon: await runtime.loadIcon("fork.png"),
    };
  },
  async isInstalled(runtime) {
    return runtime.hasMacApplication("Fork");
  },
  async launch(input, runtime) {
    if (!runtime.hasMacApplication("Fork")) throw new Error("Fork is not installed");
    await runtime.openMacApplication({ applicationName: "Fork", paths: [input.workspacePath] });
  },
};
