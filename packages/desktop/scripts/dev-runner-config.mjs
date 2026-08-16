export function createElectronSpawnOptions({ env, colorEnv, expoDevUrl }) {
  return {
    // Electron must stay in the runner's process group. Paseo workspace scripts
    // own the terminal process group, so detaching Electron lets it survive a
    // service stop with broken stdout/stderr pipes and block the next launch.
    detached: false,
    env: {
      ...env,
      ...colorEnv,
      EXPO_DEV_URL: expoDevUrl,
    },
  };
}

export function resolveNpxInvocation(platform, args, windowsShell = "cmd.exe") {
  if (platform === "win32") {
    return {
      command: windowsShell,
      args: ["/d", "/s", "/c", "npx.cmd", ...args],
    };
  }

  return { command: "npx", args };
}

export function resolveChildTermination(platform, pid, detached) {
  if (platform === "win32" && detached) {
    return {
      kind: "taskkill",
      args: ["/PID", String(pid), "/T", "/F"],
    };
  }

  return {
    kind: "signal",
    target: detached ? -pid : pid,
  };
}

export function registerDevRunnerShutdownSignals({ signalSource, stop }) {
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
    signalSource.on(signal, () => stop("SIGTERM"));
  }
}
