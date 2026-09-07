/**
 * Whether the native Paseo tool catalog is available to a provider session,
 * independent of whether the daemon injects its MCP server into agents.
 *
 * The native catalog is a separate delivery channel from daemon MCP injection.
 * Deployments that serve MCP caller-scoped (each seat gets its own
 * caller-scoped server, so daemon-wide injection is off) still need the native
 * catalog for their coordinator seats — and, via the per-provider
 * {@link ProviderPaseoToolsPolicy}, disabled for worker seats. Gating the
 * catalog on `mcp.injectIntoAgents` makes the whole channel disappear for
 * exactly those deployments.
 *
 * The master switch therefore follows the MCP stack being enabled
 * (`daemon.mcp.enabled`), and injection controls only the injected MCP server.
 * The per-provider policy remains the seat-level gate on top of this: an
 * enabled stack plus an enabled policy is what delivers the catalog to a given
 * provider session.
 */
export function isNativePaseoToolsEnabled(mcpEnabled: boolean | undefined): boolean {
  return (mcpEnabled ?? true) !== false;
}
