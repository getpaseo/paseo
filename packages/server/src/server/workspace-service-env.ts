import { buildScriptHostname } from "../utils/script-hostname.js";

export interface WorkspaceServicePeer {
  scriptName: string;
  port: number;
}

export interface BuildWorkspaceServiceEnvOptions {
  scriptName: string;
  projectSlug: string;
  branchName: string | null;
  daemonPort: number | null | undefined;
  daemonListenHost: string | null | undefined;
  peers: readonly WorkspaceServicePeer[];
}

export function normalizeServiceEnvName(scriptName: string): string {
  return scriptName
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function buildWorkspaceServiceEnv(
  options: BuildWorkspaceServiceEnvOptions,
): Record<string, string> {
  const scriptNames = options.peers.map((peer) => peer.scriptName);
  assertNoServiceEnvNameCollisions(scriptNames);

  const selfPeer = options.peers.find((peer) => peer.scriptName === options.scriptName);
  if (!selfPeer) {
    throw new Error(`Service '${options.scriptName}' is missing from workspace service peers`);
  }

  const env: Record<string, string> = {
    HOST: resolveServiceBindHost(options.daemonListenHost),
    PASEO_PORT: String(selfPeer.port),
  };

  if (options.daemonPort !== null && options.daemonPort !== undefined) {
    env.PASEO_URL = buildServiceProxyUrl({
      projectSlug: options.projectSlug,
      branchName: options.branchName,
      scriptName: options.scriptName,
      daemonPort: options.daemonPort,
    });
  }

  for (const peer of options.peers) {
    const envName = normalizeServiceEnvName(peer.scriptName);
    env[`PASEO_SERVICE_${envName}_PORT`] = String(peer.port);

    if (options.daemonPort !== null && options.daemonPort !== undefined) {
      env[`PASEO_SERVICE_${envName}_URL`] = buildServiceProxyUrl({
        projectSlug: options.projectSlug,
        branchName: options.branchName,
        scriptName: peer.scriptName,
        daemonPort: options.daemonPort,
      });
    }
  }

  return env;
}

export function resolveServiceBindHost(daemonListenHost: string | null | undefined): string {
  return isLoopbackListenHost(daemonListenHost) ? "127.0.0.1" : "0.0.0.0";
}

interface BuildServiceProxyUrlOptions {
  projectSlug: string;
  branchName: string | null;
  scriptName: string;
  daemonPort: number;
}

function buildServiceProxyUrl(options: BuildServiceProxyUrlOptions): string {
  const hostname = buildScriptHostname({
    projectSlug: options.projectSlug,
    branchName: options.branchName,
    scriptName: options.scriptName,
  });
  return `http://${hostname}:${options.daemonPort}`;
}

function isLoopbackListenHost(host: string | null | undefined): boolean {
  if (!host) {
    return true;
  }

  const normalizedHost = host.trim().toLowerCase();
  return (
    normalizedHost === "localhost" ||
    normalizedHost === "127.0.0.1" ||
    normalizedHost === "::1" ||
    normalizedHost === "[::1]"
  );
}

export function assertNoServiceEnvNameCollisions(scriptNames: readonly string[]): void {
  const scriptNamesByEnvName = new Map<string, string[]>();

  for (const scriptName of scriptNames) {
    const envName = normalizeServiceEnvName(scriptName);
    const namesForEnvName = scriptNamesByEnvName.get(envName) ?? [];
    namesForEnvName.push(scriptName);
    scriptNamesByEnvName.set(envName, namesForEnvName);
  }

  const collisions: string[] = [];
  for (const [envName, scriptNames] of scriptNamesByEnvName) {
    if (scriptNames.length > 1) {
      collisions.push(`Service env name collision for ${envName}: ${scriptNames.join(", ")}`);
    }
  }

  if (collisions.length > 0) {
    throw new Error(collisions.join("; "));
  }
}
