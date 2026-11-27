import { buildSshTunnelArgs, type SshTransportTarget } from "@getpaseo/protocol/ssh-transport";
import {
  createProcessTunnel,
  type ProcessTunnel,
  type ProcessTunnelOptions,
} from "./process-tunnel.js";

export type SshTunnel = ProcessTunnel;

export function resolveSshFailureDetail(failure: string | null, stderr: string): string | null {
  return failure ?? (stderr.trim() || null);
}

export function createSshTunnel(
  target: SshTransportTarget,
  options: ProcessTunnelOptions = {},
): Promise<SshTunnel> {
  return createProcessTunnel({
    executable: "ssh",
    args: buildSshTunnelArgs(target),
    options,
    describeStderr: (stderr) => resolveSshFailureDetail(null, stderr),
  });
}
