import net from "node:net";
import path from "node:path";

const DEFAULT_REMOTE_DEBUGGING_PORT = 9223;

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

export function findAvailablePort(preferredPort, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") {
        resolve(findAvailablePort(0, host));
        return;
      }
      reject(error);
    });
    server.listen(preferredPort, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not resolve an available CDP port"));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

export async function selectRemoteDebuggingPort({
  configuredPort,
  preferredPort = DEFAULT_REMOTE_DEBUGGING_PORT,
  findAvailablePort: findPort = findAvailablePort,
} = {}) {
  if (configuredPort) {
    return parsePort(configuredPort, "PASEO_ELECTRON_REMOTE_DEBUGGING_PORT");
  }
  return findPort(preferredPort);
}

export async function resolveDevRuntime(env = process.env) {
  const remoteDebuggingPort = await selectRemoteDebuggingPort({
    configuredPort: env.PASEO_ELECTRON_REMOTE_DEBUGGING_PORT,
  });
  return {
    electronFlags: buildElectronFlags(env.PASEO_ELECTRON_FLAGS, remoteDebuggingPort),
    remoteDebuggingPort,
    userDataDir: resolveDevUserDataDir({
      devRoot: env.PASEO_DEV_ROOT,
      inheritedUserDataDir: env.PASEO_ELECTRON_USER_DATA_DIR,
      fallbackRoot: env.PASEO_DEV_RUNTIME_FALLBACK_ROOT,
    }),
  };
}
