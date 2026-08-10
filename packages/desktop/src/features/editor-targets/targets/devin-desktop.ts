import type { EditorTarget, EditorTargetLaunchInput, EditorTargetRuntime } from "../target.js";

function commands(runtime: EditorTargetRuntime): string[] {
  const candidates = ["devin-desktop"];

  if (runtime.platform === "darwin") {
    candidates.push("/Applications/Devin.app/Contents/Resources/app/bin/devin-desktop");
    if (runtime.env.HOME) {
      candidates.push(
        `${runtime.env.HOME}/Applications/Devin.app/Contents/Resources/app/bin/devin-desktop`,
      );
    }
  }

  if (runtime.platform === "win32") {
    if (runtime.env.LOCALAPPDATA) {
      candidates.push(`${runtime.env.LOCALAPPDATA}/Programs/Devin/bin/devin-desktop`);
      candidates.push(`${runtime.env.LOCALAPPDATA}/Programs/Devin/bin/devin-desktop.cmd`);
      candidates.push(`${runtime.env.LOCALAPPDATA}/Programs/Devin/Devin.exe`);
      candidates.push(`${runtime.env.LOCALAPPDATA}/Programs/Windsurf/bin/windsurf`);
      candidates.push(`${runtime.env.LOCALAPPDATA}/Programs/Windsurf/bin/windsurf.cmd`);
      candidates.push(`${runtime.env.LOCALAPPDATA}/Programs/Windsurf/Windsurf.exe`);
    }
    if (runtime.env.ProgramFiles) {
      candidates.push(`${runtime.env.ProgramFiles}/Devin/bin/devin-desktop`);
      candidates.push(`${runtime.env.ProgramFiles}/Devin/bin/devin-desktop.cmd`);
      candidates.push(`${runtime.env.ProgramFiles}/Devin/Devin.exe`);
      candidates.push(`${runtime.env.ProgramFiles}/Windsurf/bin/windsurf`);
      candidates.push(`${runtime.env.ProgramFiles}/Windsurf/bin/windsurf.cmd`);
      candidates.push(`${runtime.env.ProgramFiles}/Windsurf/Windsurf.exe`);
    }
    if (runtime.env["ProgramFiles(x86)"]) {
      candidates.push(`${runtime.env["ProgramFiles(x86)"]}/Devin/bin/devin-desktop`);
      candidates.push(`${runtime.env["ProgramFiles(x86)"]}/Devin/bin/devin-desktop.cmd`);
      candidates.push(`${runtime.env["ProgramFiles(x86)"]}/Devin/Devin.exe`);
      candidates.push(`${runtime.env["ProgramFiles(x86)"]}/Windsurf/bin/windsurf`);
      candidates.push(`${runtime.env["ProgramFiles(x86)"]}/Windsurf/bin/windsurf.cmd`);
      candidates.push(`${runtime.env["ProgramFiles(x86)"]}/Windsurf/Windsurf.exe`);
    }
  }

  if (runtime.platform === "linux") {
    candidates.push("/usr/bin/devin-desktop");
    candidates.push("/usr/share/devin-desktop/devin-desktop");
    candidates.push("/opt/devin-desktop/devin-desktop");
    // Legacy Windsurf paths, kept for the transition period after the rebrand.
    candidates.push("/usr/bin/windsurf");
    candidates.push("/usr/share/windsurf/windsurf");
    candidates.push("/opt/windsurf/windsurf");
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

export const devinTarget: EditorTarget = {
  id: "devin-desktop",
  async describe(runtime) {
    return {
      id: this.id,
      label: "Devin",
      kind: "editor",
      icon: await runtime.loadIcon("devin-desktop.png"),
    };
  },
  async isInstalled(runtime) {
    return (
      runtime.resolveCommand(commands(runtime)) !== null ||
      runtime.hasMacApplication("Devin") ||
      runtime.hasMacApplication("Windsurf")
    );
  },
  async launch(input, runtime) {
    const command = runtime.resolveCommand(commands(runtime));
    if (command) {
      await runtime.spawnDetached({ command, args: launchArgs(input) });
      return;
    }

    if (runtime.hasMacApplication("Devin")) {
      await runtime.openMacApplication({
        applicationName: "Devin",
        paths: input.filePath ? [input.workspacePath, input.filePath] : [input.workspacePath],
      });
      return;
    }

    if (runtime.hasMacApplication("Windsurf")) {
      await runtime.openMacApplication({
        applicationName: "Windsurf",
        paths: input.filePath ? [input.workspacePath, input.filePath] : [input.workspacePath],
      });
      return;
    }

    throw new Error("Devin Desktop is not installed");
  },
};
