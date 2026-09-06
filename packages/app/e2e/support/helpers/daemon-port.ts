import { escapeRegex } from "./regex";

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
    throw new Error("E2E_DAEMON_PORT is not set (expected from the Playwright worker fixture).");
  }
  if (port === "6767") {
    throw new Error("E2E_DAEMON_PORT must not point at the developer daemon (6767).");
  }
  return port;
}

/**
 * Playwright `routeWebSocket` matcher for a WebSocket on `port`. Matches the
 * `:<port>` segment at a word boundary, so it catches the URL regardless of
 * host or path. Use this when intercepting connections to an arbitrary port
 * (e.g. blocking an unreachable test host); for the E2E daemon itself, prefer
 * `daemonWsRoutePattern()`.
 */
export function wsRoutePatternForPort(port: string): RegExp {
  return new RegExp(`:${escapeRegex(port)}\\b`);
}

/** `routeWebSocket` matcher for the isolated E2E daemon's WebSocket. */
export function daemonWsRoutePattern(): RegExp {
  return wsRoutePatternForPort(getE2EDaemonPort());
}

const FAKE_HOST_PORT_BASE = 59_000;
const FAKE_HOST_PORTS_PER_WORKER = 20;

/**
 * A port for a fake host that never listens, derived from the Playwright
 * worker index and a caller-chosen slot. Random ports make a failure
 * impossible to reproduce and can collide between parallel workers; this keeps
 * every run identical while still isolating workers from each other.
 */
export function fakeHostPort(input: { parallelIndex: number; slot?: number }): string {
  const slot = input.slot ?? 0;
  if (slot < 0 || slot >= FAKE_HOST_PORTS_PER_WORKER) {
    throw new Error(`fake host slot must be 0..${FAKE_HOST_PORTS_PER_WORKER - 1}, got ${slot}`);
  }
  const port = FAKE_HOST_PORT_BASE + input.parallelIndex * FAKE_HOST_PORTS_PER_WORKER + slot;
  if (String(port) === process.env.E2E_DAEMON_PORT) {
    throw new Error(`fake host port ${port} collides with the E2E daemon port`);
  }
  return String(port);
}
