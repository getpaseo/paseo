export interface BuildStringCommandShellInvocationOptions {
  command: string;
  platform?: NodeJS.Platform;
}

export interface StringCommandShellInvocation {
  shell: string;
  args: string[];
}

export function buildStringCommandShellInvocation(
  options: BuildStringCommandShellInvocationOptions,
): StringCommandShellInvocation {
  const platform = options.platform ?? process.platform;

  if (platform === "win32") {
    return {
      shell: "powershell",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        options.command,
      ],
    };
  }

  return {
    shell: "/bin/bash",
    args: ["-lc", options.command],
  };
}
