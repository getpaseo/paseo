import type { Logger } from "pino";

import type {
  ListPersistedAgentsOptions,
  PersistedAgentDescriptor,
} from "../../agent-sdk-types.js";
import {
  checkProviderLaunchAvailable,
  resolveProviderLaunch,
  type ProviderRuntimeSettings,
} from "../../provider-launch-config.js";
import { PiRpcAgentClient } from "../pi/agent.js";
import { OMP_FAMILY, resolveFamilyBinaryName } from "../pi/family-config.js";
import type { PiRuntime } from "../pi/runtime.js";

import { listOmpPersistedAgents } from "./session-descriptor.js";

/**
 * OMP (Oh-My-Pi, https://github.com/oh-my-pi/pi-coding-agent) is a downstream
 * fork of Pi that ships its own binary (`omp`), home directory (`~/.omp`), and
 * plugin ecosystem. It preserves Pi's `--mode rpc` wire protocol and JSONL
 * session schema verbatim, so the entire Pi adapter is reused — only family
 * defaults differ.
 *
 * Unlike Pi (which uses Paseo-injected `paseo_capture_entries` extensions to
 * track session identity at runtime), OMP sessions started outside Paseo —
 * e.g. via `omp` invoked directly in the terminal — are discovered by reading
 * the JSONL session files on disk. The `omp/session-descriptor.ts` module
 * mirrors the historical Pi descriptor (removed upstream in #1154) but scoped
 * to OMP paths.
 */
export interface OmpRpcAgentClientOptions {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
  runtime?: PiRuntime;
}

export class OmpRpcAgentClient extends PiRpcAgentClient {
  constructor(options: OmpRpcAgentClientOptions) {
    super({ ...options, family: OMP_FAMILY });
  }

  /**
   * Lightweight availability probe matching the `claude`, `codex`, and
   * `opencode` providers: a present, launchable `omp` binary is treated as
   * available. The Pi base class additionally starts an RPC session and calls
   * `getAvailableModels()`, but OMP eagerly connects every configured MCP
   * server (`~/.omp/agent/mcp.json`) on `omp --mode rpc` startup, so that probe
   * routinely exceeds the daemon's availability budget under multi-provider
   * contention. Model/MCP loading is deferred to real sessions, so capability
   * is unaffected.
   */
  override async isAvailable(): Promise<boolean> {
    const launch = await resolveProviderLaunch({
      commandConfig: this.runtimeSettings?.command,
      defaultBinary: resolveFamilyBinaryName(OMP_FAMILY),
    });
    const availability = await checkProviderLaunchAvailable(launch);
    return availability.available;
  }

  override async listPersistedAgents(
    options?: ListPersistedAgentsOptions,
  ): Promise<PersistedAgentDescriptor[]> {
    return await listOmpPersistedAgents({
      ...options,
      runtimeSettings: this.runtimeSettings,
    });
  }
}
