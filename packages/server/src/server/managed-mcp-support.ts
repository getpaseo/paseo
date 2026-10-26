/**
 * Managed MCP openings rely on a durable reservation journal: file sync plus directory sync.
 * Windows cannot sync directories, so it neither advertises nor accepts managed openings.
 * Read at call time so the platform check is a single source of truth for every gate.
 */
export function isManagedMcpDurabilitySupported(): boolean {
  return process.platform !== "win32";
}
export function managedMcpAuthorizationProviders(): string[] {
  return isManagedMcpDurabilitySupported() ? ["omp"] : [];
}

export function assertManagedMcpDurabilitySupported(): void {
  if (!isManagedMcpDurabilitySupported()) {
    throw new Error(
      "Managed MCP authorization is unsupported on this platform: the durable opening journal needs directory sync; start a fresh execution on a supported host",
    );
  }
}
