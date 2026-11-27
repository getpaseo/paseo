import { createSshTunnel } from "@getpaseo/client/node";
import {
  buildSshTunnelArgs,
  DEFAULT_SSH_DAEMON_PORT,
  type SshTransportTarget,
} from "@getpaseo/protocol/ssh-transport";
import { stripAppImageRuntimeEnv } from "@getpaseo/server/process";

export { resolveSshFailureDetail } from "@getpaseo/client/node";

export interface SshProxyTarget {
  host: string;
  sshPort?: number;
  daemonPort?: number;
}

export interface SshProxyEndpoint {
  url: string;
  close: () => void;
  failureDetail: () => string | null;
}

const WS_ENDPOINT_PATH = "/ws";
function toSshTransportTarget(target: SshProxyTarget): SshTransportTarget {
  return {
    ...target,
    daemonPort: target.daemonPort ?? DEFAULT_SSH_DAEMON_PORT,
  };
}

export function buildSshProxyArgs(target: SshProxyTarget): string[] {
  return buildSshTunnelArgs(toSshTransportTarget(target));
}

export function buildSshSpawnEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  stripAppImageRuntimeEnv(env, { platform });
  return env;
}

export async function createSshProxy(
  target: SshProxyTarget,
  signal?: AbortSignal,
): Promise<SshProxyEndpoint> {
  const tunnel = await createSshTunnel(toSshTransportTarget(target), {
    env: buildSshSpawnEnv(),
    signal,
  });
  return {
    url: `ws://${tunnel.endpoint}${WS_ENDPOINT_PATH}`,
    close: tunnel.close,
    failureDetail: tunnel.failureDetail,
  };
}
