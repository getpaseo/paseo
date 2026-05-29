/**
 * Resolves the isolated E2E daemon's port, which Playwright's globalSetup
 * publishes into the environment before any spec runs. Helpers and specs that
 * build daemon WebSocket URLs, route patterns, or host endpoints share this
 * accessor instead of re-reading the env var.
 *
 * The port-6767 guard is a hard guardrail: 6767 is the developer's default
 * daemon, which manages real agents. The e2e port is never legitimately 6767,
 * so refusing it here keeps every test off the developer daemon.
 */
export function getE2EDaemonPort(): string {
  const port = process.env.E2E_DAEMON_PORT;
  if (!port) {
    throw new Error("E2E_DAEMON_PORT is not set (expected from Playwright globalSetup).");
  }
  if (port === "6767") {
    throw new Error("E2E_DAEMON_PORT must not point at the developer daemon (6767).");
  }
  return port;
}
