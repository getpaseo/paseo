/**
 * Redact secret-looking values for logging. Targets keys that commonly hold
 * credentials in MCP env vars / HTTP headers (KEY, TOKEN, SECRET, PASSWORD,
 * AUTH, COOKIE, BEARER, API).
 *
 * `redactSecrets` is shallow — apply once per record. Returns a copy.
 */
const SECRET_KEY = /(KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH|COOKIE|BEARER|API)/i;

export function redactSecrets<T extends Record<string, unknown>>(record: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    out[k] = SECRET_KEY.test(k) ? maskValue(v) : v;
  }
  return out as T;
}

function maskValue(value: unknown): string {
  const s = typeof value === "string" ? value : "";
  if (s.length === 0) return "***";
  if (s.length <= 4) return "***";
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}

/**
 * Variant for the `Authorization: Bearer xyz` style — keeps the scheme but
 * masks the credential portion.
 */
export function redactAuthorizationHeader(value: string): string {
  const idx = value.indexOf(" ");
  if (idx < 0) return maskValue(value);
  return `${value.slice(0, idx + 1)}${maskValue(value.slice(idx + 1))}`;
}
