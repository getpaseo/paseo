/**
 * Minimal TOML serializer for the shapes we emit into Codex's config.toml.
 * Codex accepts:
 *
 *   [mcp_servers.<name>]
 *   command = "npx"
 *   args = ["-y", "@playwright/mcp@latest"]
 *   env = { KEY = "value" }
 *
 * We don't need full TOML; this avoids a dependency.
 */

function escapeString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function tomlValue(value: unknown): string {
  if (typeof value === "string") return escapeString(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    return `[${value.map((v) => tomlValue(v)).join(", ")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return `{ ${entries.map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v)}`).join(", ")} }`;
  }
  throw new Error(`Unsupported TOML value: ${String(value)}`);
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : escapeString(key);
}

/**
 * Render a single nested table block. `tablePath` is dot-joined for the
 * header — e.g. ["mcp_servers", "playwright"] → "[mcp_servers.playwright]".
 */
export function renderTomlTable(tablePath: string[], data: Record<string, unknown>): string {
  const lines = [`[${tablePath.map(tomlKey).join(".")}]`];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    lines.push(`${tomlKey(k)} = ${tomlValue(v)}`);
  }
  return lines.join("\n");
}
