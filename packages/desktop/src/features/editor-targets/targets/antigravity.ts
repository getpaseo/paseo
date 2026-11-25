import type { EditorTarget, EditorTargetLaunchInput, EditorTargetRuntime } from "../target.js";

// On macOS the IDE ships `antigravity-ide`. `agy` is the standalone Antigravity CLI agent and
// `Antigravity.app` (com.google.antigravity) is a separate app: neither opens the editor.
// IDE builds from before the rename keep their launcher at Antigravity.app/.../bin/antigravity.
const APP_NAME = "Antigravity IDE";

function commands(runtime: EditorTargetRuntime): string[] {
  // `antigravity` is the launcher on other platforms and in builds before the rename.
  const candidates = ["antigravity-ide", "antigravity"];
  if (runtime.platform === "darwin") {
    const roots = ["/Applications"];
    if (runtime.env.HOME) roots.push(`${runtime.env.HOME}/Applications`);
    for (const root of roots) {
      candidates.push(`${root}/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide`);
      candidates.push(`${root}/Antigravity.app/Contents/Resources/app/bin/antigravity`);
    }
  }
  return candidates;
}

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
    return (
      runtime.resolveCommand(commands(runtime)) !== null || runtime.hasMacApplication(APP_NAME)
    );
  },
  async launch(input, runtime) {
    const command = runtime.resolveCommand(commands(runtime));
    if (command) {
      await runtime.spawnDetached({ command, args: launchArgs(input) });
      return;
    }
    if (runtime.hasMacApplication(APP_NAME)) {
      await runtime.openMacApplication({
        applicationName: APP_NAME,
        paths: input.filePath ? [input.workspacePath, input.filePath] : [input.workspacePath],
      });
      return;
    }
    throw new Error("Antigravity is not installed");
  },
};
