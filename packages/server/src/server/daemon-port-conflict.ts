export interface ProbeOptions {
  timeoutMs?: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 1_000;
export const PASEO_HEALTH_HEADER = "x-paseo-daemon";
export const PASEO_HEALTH_HEADER_VALUE = "1";

/** True when an error is Node's "port already bound" listen failure. */
export function isAddressInUseError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "EADDRINUSE"
  );
}

/**
 * Probe whether a healthy Paseo daemon already owns `host:port` by hitting its
 * unauthenticated `/api/health` endpoint. Used when a worker hits EADDRINUSE so
 * it can yield to the existing daemon instead of fighting for the port.
 * Returns false on any error, non-2xx, or non-Paseo response.
 */
export async function isHealthyPaseoDaemonAt(
  host: string,
  port: number,
  options?: ProbeOptions,
): Promise<boolean> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://${host}:${port}/api/health`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return false;
    }
    if (response.headers.get(PASEO_HEALTH_HEADER) !== PASEO_HEALTH_HEADER_VALUE) {
      return false;
    }
    const body: unknown = await response.json().catch(() => null);
    return (
      typeof body === "object" && body !== null && (body as { status?: unknown }).status === "ok"
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
