import type { EditorTarget, EditorTargetRuntime } from "../target.js";

type SupportedPlatform = "darwin" | "linux" | "win32";

interface CommandTerminalDefinition {
  id: string;
  label: string;
  iconFileName: string;
  platforms: readonly SupportedPlatform[];
  commands(runtime: EditorTargetRuntime): readonly string[];
  args(workspacePath: string): readonly string[];
}

function isSupportedPlatform(
  runtime: EditorTargetRuntime,
  platforms: readonly SupportedPlatform[],
): boolean {
  return platforms.some((platform) => platform === runtime.platform);
}

function createCommandTerminal(definition: CommandTerminalDefinition): EditorTarget {
  return {
    id: definition.id,
    async describe(runtime) {
      return {
        id: this.id,
        label: definition.label,
        kind: "terminal",
        icon: await runtime.loadIcon(definition.iconFileName),
      };
    },
    async isInstalled(runtime) {
      return (
        isSupportedPlatform(runtime, definition.platforms) &&
        runtime.resolveCommand(definition.commands(runtime)) !== null
      );
    },
    async launch(input, runtime) {
      const command = runtime.resolveCommand(definition.commands(runtime));
      if (!command || !isSupportedPlatform(runtime, definition.platforms)) {
        throw new Error(`${definition.label} is not installed`);
      }
      await runtime.spawnDetached({
        command,
        args: definition.args(input.workspacePath),
      });
    },
  };
}

function macApplicationCommands(
  runtime: EditorTargetRuntime,
  applicationName: string,
  executableName: string,
): string[] {
  const commands = [executableName];
  if (runtime.platform !== "darwin") return commands;
  commands.push(`/Applications/${applicationName}.app/Contents/MacOS/${executableName}`);
  if (runtime.env.HOME) {
    commands.push(
      `${runtime.env.HOME}/Applications/${applicationName}.app/Contents/MacOS/${executableName}`,
    );
  }
  return commands;
}

function windowsApplicationCommands(
  runtime: EditorTargetRuntime,
  executableName: string,
  relativePaths: readonly string[],
): string[] {
  const commands = [executableName];
  if (runtime.platform !== "win32") return commands;
  for (const relativePath of relativePaths) {
    if (runtime.env.LOCALAPPDATA) {
      commands.push(`${runtime.env.LOCALAPPDATA}/${relativePath}`);
    }
    if (runtime.env.ProgramFiles) {
      commands.push(`${runtime.env.ProgramFiles}/${relativePath}`);
    }
  }
  return commands;
}

export const ghosttyTerminalTarget: EditorTarget = {
  id: "terminal:ghostty",
  async describe(runtime) {
    return {
      id: this.id,
      label: "Ghostty",
      kind: "terminal",
      icon: await runtime.loadIcon("ghostty.png"),
    };
  },
  async isInstalled(runtime) {
    if (runtime.platform === "darwin") return runtime.hasMacApplication("Ghostty");
    if (runtime.platform === "linux") return runtime.resolveCommand(["ghostty"]) !== null;
    return false;
  },
  async launch(input, runtime) {
    if (runtime.platform === "darwin" && runtime.hasMacApplication("Ghostty")) {
      await runtime.openMacApplication({
        applicationName: "Ghostty",
        paths: [input.workspacePath],
      });
      return;
    }
    if (runtime.platform === "linux") {
      const command = runtime.resolveCommand(["ghostty"]);
      if (command) {
        await runtime.spawnDetached({
          command,
          args: ["+new-window", `--working-directory=${input.workspacePath}`],
        });
        return;
      }
    }
    throw new Error("Ghostty is not installed");
  },
};

export const itermTerminalTarget: EditorTarget = {
  id: "terminal:iterm2",
  async describe(runtime) {
    return {
      id: this.id,
      label: "iTerm2",
      kind: "terminal",
      icon: await runtime.loadIcon("iterm2.png"),
    };
  },
  async isInstalled(runtime) {
    return runtime.platform === "darwin" && runtime.hasMacApplication("iTerm");
  },
  async launch(input, runtime) {
    if (runtime.platform !== "darwin" || !runtime.hasMacApplication("iTerm")) {
      throw new Error("iTerm2 is not installed");
    }
    await runtime.openMacApplication({
      applicationName: "iTerm",
      paths: [input.workspacePath],
    });
  },
};

export const macTerminalTarget: EditorTarget = {
  id: "terminal:macos",
  async describe(runtime) {
    return {
      id: this.id,
      label: "Terminal",
      kind: "terminal",
      icon: await runtime.loadIcon("macos-terminal.png"),
    };
  },
  async isInstalled(runtime) {
    return runtime.platform === "darwin";
  },
  async launch(input, runtime) {
    if (runtime.platform !== "darwin") throw new Error("Terminal is unavailable");
    await runtime.openMacApplication({
      applicationName: "Terminal",
      paths: [input.workspacePath],
    });
  },
};

function warpCommands(runtime: EditorTargetRuntime): string[] {
  if (runtime.platform === "linux") return ["warp-terminal", "warp"];
  if (runtime.platform !== "win32") return [];
  return windowsApplicationCommands(runtime, "Warp.exe", ["Programs/Warp/Warp.exe"]);
}

export const warpTerminalTarget: EditorTarget = {
  id: "terminal:warp",
  async describe(runtime) {
    return {
      id: this.id,
      label: "Warp",
      kind: "terminal",
      icon: await runtime.loadIcon("warp.png"),
    };
  },
  async isInstalled(runtime) {
    if (runtime.platform === "darwin") return runtime.hasMacApplication("Warp");
    return (
      runtime.resolveCommand(warpCommands(runtime)) !== null ||
      runtime.hasExternalUrlHandler("warp://action/new_window")
    );
  },
  async launch(input, runtime) {
    if (!(await this.isInstalled(runtime))) throw new Error("Warp is not installed");
    const url = new URL("warp://action/new_window");
    url.searchParams.set("path", input.workspacePath);
    await runtime.openExternalUrl(url.toString());
  },
};

export const weztermTerminalTarget = createCommandTerminal({
  id: "terminal:wezterm",
  label: "WezTerm",
  iconFileName: "wezterm.png",
  platforms: ["darwin", "linux", "win32"],
  commands(runtime) {
    const commands = macApplicationCommands(runtime, "WezTerm", "wezterm");
    if (runtime.platform !== "win32") return commands;
    return windowsApplicationCommands(runtime, "wezterm.exe", ["WezTerm/wezterm.exe"]);
  },
  args: (workspacePath) => ["start", "--cwd", workspacePath],
});

export const kittyTerminalTarget: EditorTarget = {
  id: "terminal:kitty",
  async describe(runtime) {
    return {
      id: this.id,
      label: "kitty",
      kind: "terminal",
      icon: await runtime.loadIcon("kitty.png"),
    };
  },
  async isInstalled(runtime) {
    if (runtime.platform === "win32") return false;
    return (
      runtime.resolveCommand(macApplicationCommands(runtime, "kitty", "kitty")) !== null ||
      runtime.hasMacApplication("kitty")
    );
  },
  async launch(input, runtime) {
    if (runtime.platform === "darwin" && runtime.hasMacApplication("kitty")) {
      await runtime.spawnDetached({
        command: "/usr/bin/open",
        args: ["-na", "kitty.app", "--args", "--directory", input.workspacePath],
      });
      return;
    }
    const command = runtime.resolveCommand(["kitty"]);
    if (!command || runtime.platform === "win32") throw new Error("kitty is not installed");
    await runtime.spawnDetached({ command, args: ["--directory", input.workspacePath] });
  },
};

export const alacrittyTerminalTarget = createCommandTerminal({
  id: "terminal:alacritty",
  label: "Alacritty",
  iconFileName: "alacritty.png",
  platforms: ["darwin", "linux", "win32"],
  commands(runtime) {
    const commands = macApplicationCommands(runtime, "Alacritty", "alacritty");
    if (runtime.platform !== "win32") return commands;
    return windowsApplicationCommands(runtime, "alacritty.exe", ["Alacritty/alacritty.exe"]);
  },
  args: (workspacePath) => ["--working-directory", workspacePath],
});

export const windowsTerminalTarget = createCommandTerminal({
  id: "terminal:windows-terminal",
  label: "Windows Terminal",
  iconFileName: "windows-terminal.png",
  platforms: ["win32"],
  commands(runtime) {
    const commands = ["wt.exe", "wt"];
    if (runtime.env.LOCALAPPDATA) {
      commands.push(`${runtime.env.LOCALAPPDATA}/Microsoft/WindowsApps/wt.exe`);
    }
    return commands;
  },
  args: (workspacePath) => ["-d", workspacePath],
});

export const gnomeTerminalTarget = createCommandTerminal({
  id: "terminal:gnome-terminal",
  label: "GNOME Terminal",
  iconFileName: "gnome-terminal.png",
  platforms: ["linux"],
  commands: () => ["gnome-terminal"],
  args: (workspacePath) => [`--working-directory=${workspacePath}`],
});

export const gnomeConsoleTarget = createCommandTerminal({
  id: "terminal:gnome-console",
  label: "GNOME Console",
  iconFileName: "gnome-console.png",
  platforms: ["linux"],
  commands: () => ["kgx"],
  args: (workspacePath) => [`--working-directory=${workspacePath}`],
});

export const ptyxisTerminalTarget = createCommandTerminal({
  id: "terminal:ptyxis",
  label: "Ptyxis",
  iconFileName: "ptyxis.png",
  platforms: ["linux"],
  commands: () => ["ptyxis"],
  args: (workspacePath) => ["--new-window", "--working-directory", workspacePath],
});

export const konsoleTerminalTarget = createCommandTerminal({
  id: "terminal:konsole",
  label: "Konsole",
  iconFileName: "konsole.png",
  platforms: ["linux"],
  commands: () => ["konsole"],
  args: (workspacePath) => ["--workdir", workspacePath],
});

export const tilixTerminalTarget = createCommandTerminal({
  id: "terminal:tilix",
  label: "Tilix",
  iconFileName: "tilix.png",
  platforms: ["linux"],
  commands: () => ["tilix"],
  args: (workspacePath) => [`--working-directory=${workspacePath}`],
});

export const xfceTerminalTarget = createCommandTerminal({
  id: "terminal:xfce",
  label: "Xfce Terminal",
  iconFileName: "xfce-terminal.png",
  platforms: ["linux"],
  commands: () => ["xfce4-terminal"],
  args: (workspacePath) => [`--working-directory=${workspacePath}`],
});

export const linuxDefaultTerminalTarget: EditorTarget = {
  id: "terminal:linux-default",
  async describe() {
    return {
      id: this.id,
      label: "Default Terminal",
      kind: "terminal",
      icon: { kind: "symbol", name: "terminal" },
    };
  },
  async isInstalled(runtime) {
    return runtime.platform === "linux" && runtime.resolveCommand(["xdg-terminal-exec"]) !== null;
  },
  async launch(input, runtime) {
    const command = runtime.resolveCommand(["xdg-terminal-exec"]);
    if (!command || runtime.platform !== "linux") {
      throw new Error("Default terminal is unavailable");
    }
    await runtime.spawnDetached({ command, args: [`--dir=${input.workspacePath}`] });
  },
};
