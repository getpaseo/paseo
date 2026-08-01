import path from "node:path";

export function resolveDevUserDataDir({ devRoot, inheritedUserDataDir, fallbackRoot }) {
  if (devRoot) {
    return path.join(devRoot, ".dev", "user-data");
  }
  if (inheritedUserDataDir) {
    return inheritedUserDataDir;
  }
  if (!fallbackRoot) {
    throw new Error("A dev root or fallback root is required");
  }
  return path.join(fallbackRoot, ".dev", "user-data");
}

export function buildElectronFlags(inheritedFlags, remoteDebuggingPort) {
  const flags = (inheritedFlags ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .filter((flag) => !flag.startsWith("--remote-debugging-port="));
  flags.push(`--remote-debugging-port=${remoteDebuggingPort}`);
  return flags.join(" ");
}

function parsePort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return port;
}

export function resolveDevRuntime(env = process.env) {
  const remoteDebuggingPort = env.PASEO_ELECTRON_REMOTE_DEBUGGING_PORT
    ? parsePort(env.PASEO_ELECTRON_REMOTE_DEBUGGING_PORT, "PASEO_ELECTRON_REMOTE_DEBUGGING_PORT")
    : 0;
  return {
    electronFlags: buildElectronFlags(env.PASEO_ELECTRON_FLAGS, remoteDebuggingPort),
    userDataDir: resolveDevUserDataDir({
      devRoot: env.PASEO_DEV_ROOT,
      inheritedUserDataDir: env.PASEO_ELECTRON_USER_DATA_DIR,
      fallbackRoot: env.PASEO_DEV_RUNTIME_FALLBACK_ROOT,
    }),
  };
}
