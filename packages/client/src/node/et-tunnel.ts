import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildEtTunnelArgs, type EtTransportTarget } from "@getpaseo/protocol/et-transport";
import {
  createProcessTunnel,
  type ProcessTunnel,
  type ProcessTunnelOptions,
} from "./process-tunnel.js";

const run = promisify(execFile);

export class EtTunnelSetupError extends Error {
  override name = "EtTunnelSetupError";
}

export function describeEtTunnelFailure(detail: string | null): string {
  return (
    detail ??
    "Eternal Terminal could not forward the Paseo WebSocket. Check etserver and the remote Paseo daemon port."
  );
}

function describeEtStderr(stderr: string): string | null {
  if (
    /permission denied|authentication failed|host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(
      stderr,
    )
  ) {
    return "SSH authentication or host verification failed. Check the local SSH configuration.";
  }
  return null;
}

async function assertEtVersion(options: ProcessTunnelOptions): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await run("et", ["--version"], {
      env: options.env,
      signal: options.signal,
      timeout: 3_000,
      maxBuffer: 4_096,
    }));
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new EtTunnelSetupError(
        "Eternal Terminal is missing. Install et 7.1.1 or later on this machine.",
      );
    }
    throw new EtTunnelSetupError(
      "Could not check the local Eternal Terminal version. Verify that et can run.",
    );
  }
  const version = /^et version (\d+)\.(\d+)\.(\d+)\s*$/i.exec(stdout);
  const [major, minor, patch] = version?.slice(1).map(Number) ?? [];
  const supported = major > 7 || (major === 7 && (minor > 1 || (minor === 1 && patch >= 1)));
  if (!supported) {
    throw new EtTunnelSetupError(
      "Unsupported Eternal Terminal version. Install et 7.1.1 or later on this machine.",
    );
  }
}

export async function createEtTunnel(
  target: EtTransportTarget,
  options: ProcessTunnelOptions = {},
): Promise<ProcessTunnel> {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new EtTunnelSetupError("Eternal Terminal connections are supported on macOS and Linux.");
  }
  const args = buildEtTunnelArgs(target);
  await assertEtVersion(options);
  return createProcessTunnel({ executable: "et", args, options, describeStderr: describeEtStderr });
}
