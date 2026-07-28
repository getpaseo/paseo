/**
 * Resolves the isolated E2E daemon's server id, which Playwright's globalSetup
 * publishes into the environment before any spec runs. Helpers and specs that
 * build host routes or `sidebar-workspace-row-${serverId}:${id}` selectors share
 * this accessor instead of re-reading the env var.
 */
export function getServerId(): string {
  const serverId = process.env.E2E_SERVER_ID;
  if (!serverId) {
    throw new Error("E2E_SERVER_ID is not set (expected from Playwright globalSetup).");
  }
  return serverId;
}
