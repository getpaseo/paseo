import { isToolEnabledForAgent, type IndexingState } from "./types.js";

/**
 * Tool manifest shape we care about for filtering. A subset of
 * `@modelcontextprotocol/sdk`'s `Tool` — kept minimal so the filter can be
 * tested without depending on the SDK types.
 */
export interface CrgToolManifest {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
}

export const CRG_TOOL_PREFIX = "crg_";

/**
 * Prefix a raw crg tool name with the `crg_` namespace used when exposing
 * the proxy to agents.
 */
export function toNamespacedToolName(rawName: string): string {
  if (rawName.startsWith(CRG_TOOL_PREFIX)) return rawName;
  return `${CRG_TOOL_PREFIX}${rawName}`;
}

/**
 * Strip the `crg_` prefix back off a namespaced name when forwarding to the
 * crg subprocess. Returns `null` if the name isn't a crg tool.
 */
export function fromNamespacedToolName(namespaced: string): string | null {
  if (!namespaced.startsWith(CRG_TOOL_PREFIX)) return null;
  return namespaced.slice(CRG_TOOL_PREFIX.length);
}

/**
 * Re-exports the namespacing applied to a list of raw tools.
 */
export function namespaceCrgTools(tools: readonly CrgToolManifest[]): CrgToolManifest[] {
  return tools.map((tool) => ({ ...tool, name: toNamespacedToolName(tool.name) }));
}

/**
 * Filter a namespaced tool list to the subset the given agent may call on a
 * given workspace. All defaults are on-on-on: indexing enabled + no exposeTo
 * entry for the agent + no per-tool list → all tools are allowed.
 *
 * Both the namespaced (`crg_blast_radius`) and bare (`blast_radius`) forms
 * are accepted in `enabledTools` to keep UI simple.
 */
export function filterToolsForAgent(
  namespacedTools: readonly CrgToolManifest[],
  state: IndexingState,
  agentId: string,
): CrgToolManifest[] {
  if (!state.enabled) return [];
  return namespacedTools.filter((tool) => {
    const raw = fromNamespacedToolName(tool.name) ?? tool.name;
    return (
      isToolEnabledForAgent(state, agentId, tool.name) || isToolEnabledForAgent(state, agentId, raw)
    );
  });
}

/**
 * Authorization check for a single tool call. Returns a human-readable reason
 * on denial so the proxy can surface it back to the agent.
 */
export function authorizeToolCall(
  state: IndexingState,
  agentId: string,
  namespacedToolName: string,
): { ok: true } | { ok: false; reason: string } {
  if (!state.enabled) {
    return { ok: false, reason: "Code indexing is disabled for this workspace." };
  }
  const raw = fromNamespacedToolName(namespacedToolName) ?? namespacedToolName;
  const allowedByNamespace = isToolEnabledForAgent(state, agentId, namespacedToolName);
  const allowedByRaw = isToolEnabledForAgent(state, agentId, raw);
  if (!allowedByNamespace && !allowedByRaw) {
    return {
      ok: false,
      reason: `Tool ${namespacedToolName} is not enabled for agent ${agentId} on this workspace.`,
    };
  }
  return { ok: true };
}
