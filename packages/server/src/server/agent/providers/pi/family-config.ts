/**
 * Configuration shared by Pi-compatible providers.
 *
 * Pi (https://github.com/earendil-works/pi-coding-agent) and OMP (Oh-My-Pi,
 * https://github.com/oh-my-pi/pi-coding-agent) speak the same JSONL session
 * format and the same `--mode rpc` wire protocol. They differ only in binary
 * name and home directory. Everything else — message schema, tool calls,
 * permission dialogs, MCP adapter, model labels, Paseo's `paseo_capture_entries`
 * / `paseo_tree` extension commands — is identical.
 *
 * The Pi adapter is parameterized over this family config so OMP can reuse
 * the entire implementation by swapping a handful of identifiers.
 */
export interface PiFamilyConfig {
  /** Provider id used in AgentStreamEvent payloads and the provider registry. */
  readonly providerId: string;
  /** Default binary name on PATH. */
  readonly binaryName: string;
  /**
   * Environment variables, in priority order, that override the binary path.
   * The first non-empty value wins. Variables not in this list are ignored.
   */
  readonly binaryEnvVars: ReadonlyArray<string>;
  /** Home dotdir for the agent (e.g. `.pi`, `.omp`). */
  readonly homeDirName: string;
  /** Environment variable that overrides the agent directory location. */
  readonly agentDirEnv: string;
  /** Environment variable that overrides the sessions directory location. */
  readonly sessionDirEnv: string;
  /** Human-readable label used in diagnostics and error messages. */
  readonly displayLabel: string;
  /**
   * Substring used to detect the MCP adapter command via Pi's `get_commands`
   * RPC. Pi ships `pi-mcp-adapter`; OMP currently reuses the same adapter
   * package via its plugin loader, so both families share the marker.
   */
  readonly mcpAdapterMarker: string;
  /**
   * When true, keep the upstream LLM provider prefix in model labels (e.g.
   * `anthropic/Claude Opus 4.5`). OMP exposes ~980 models across ~15 providers,
   * so the same model name recurs under several providers; without the prefix
   * the picker shows indistinguishable duplicates. Pi has a small, mostly
   * unique model set and keeps the cleaner provider-less label.
   */
  readonly keepModelProviderInLabel: boolean;
}

export const PI_FAMILY: PiFamilyConfig = {
  providerId: "pi",
  binaryName: "pi",
  binaryEnvVars: ["PI_COMMAND", "PI_ACP_PI_COMMAND"],
  homeDirName: ".pi",
  agentDirEnv: "PI_CODING_AGENT_DIR",
  sessionDirEnv: "PI_CODING_AGENT_SESSION_DIR",
  displayLabel: "Pi",
  mcpAdapterMarker: "pi-mcp-adapter",
  keepModelProviderInLabel: false,
};

export const OMP_FAMILY: PiFamilyConfig = {
  providerId: "omp",
  binaryName: "omp",
  binaryEnvVars: ["OMP_COMMAND", "OMP_ACP_OMP_COMMAND"],
  homeDirName: ".omp",
  agentDirEnv: "OMP_CODING_AGENT_DIR",
  sessionDirEnv: "OMP_CODING_AGENT_SESSION_DIR",
  displayLabel: "OMP",
  mcpAdapterMarker: "pi-mcp-adapter",
  keepModelProviderInLabel: true,
};

/**
 * Resolve the binary path defined by the family's env variables. Returns the
 * first non-empty match, falling back to the family's default binary name.
 */
export function resolveFamilyBinaryName(
  family: PiFamilyConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  for (const name of family.binaryEnvVars) {
    const value = env[name];
    if (value?.trim()) {
      return value;
    }
  }
  return family.binaryName;
}
