import type { CatalogItem, CatalogPage } from "./types";

const PULSEMCP_BASE = "https://api.pulsemcp.com/v0beta/servers";

interface PulseMcpServer {
  name: string;
  url?: string | null;
  external_url?: string | null;
  short_description?: string | null;
  source_code_url?: string | null;
  github_stars?: number | null;
  package_registry?: string | null;
  package_name?: string | null;
  EXPERIMENTAL_ai_generated_description?: string | null;
  remotes?: Array<{ transport_type?: string; url?: string }>;
}

interface PulseMcpResponse {
  servers?: PulseMcpServer[];
  total_count?: number;
  next?: string | null;
}

export interface FetchMcpParams {
  query?: string;
  /** Opaque — we treat this as the full upstream `next` URL. */
  cursor?: string;
  countPerPage?: number;
}

/**
 * Fetch a page of MCP servers from PulseMCP. No auth required on v0beta.
 * Returns CatalogItems normalized for the UI.
 */
export async function fetchPulseMcp(params: FetchMcpParams): Promise<CatalogPage> {
  let url: string;
  if (params.cursor) {
    url = params.cursor;
  } else {
    const u = new URL(PULSEMCP_BASE);
    if (params.query) u.searchParams.set("query", params.query);
    u.searchParams.set("count_per_page", String(params.countPerPage ?? 50));
    url = u.toString();
  }

  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    // Conservative timeout — upstream has been flaky during incidents.
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`PulseMCP ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as PulseMcpResponse;
  const items: CatalogItem[] = (body.servers ?? []).map(normalizeServer);
  return {
    items,
    nextCursor: body.next ?? null,
    totalCount: body.total_count ?? -1,
  };
}

function normalizeServer(raw: PulseMcpServer): CatalogItem {
  const slug = slugFromUrl(raw.url);
  const id = `pulsemcp:${slug || raw.name.toLowerCase().replace(/\s+/g, "-")}`;
  const transports: Array<"stdio" | "http" | "sse"> = [];
  // Remote entries indicate http/sse transport availability.
  for (const r of raw.remotes ?? []) {
    const t = r.transport_type?.toLowerCase();
    if (t === "http" || t === "sse") transports.push(t);
  }
  // If we have a package_name we can plausibly run stdio via npx/uvx.
  if (raw.package_name) transports.push("stdio");
  // If no remotes and no package, we still flag stdio as the fallback —
  // users often just need to edit the Command themselves before adding.
  if (transports.length === 0) transports.push("stdio");

  const install = inferInstall(raw);

  return {
    id,
    kind: "mcp",
    name: raw.name,
    description: raw.short_description ?? raw.EXPERIMENTAL_ai_generated_description ?? "",
    iconUrl: deriveLogoUrl(raw),
    // Prefer the GitHub repo (where the README with install + env var docs
    // lives) over the PulseMCP catalog mirror page. UI wraps this to build
    // a `#readme` anchor so the user lands on the relevant section.
    homepage: raw.source_code_url ?? raw.external_url ?? raw.url ?? null,
    transports: Array.from(new Set(transports)),
    install,
    popularity: raw.github_stars ?? 0,
    source: "pulsemcp",
  };
}

function slugFromUrl(pageUrl: string | null | undefined): string | null {
  if (!pageUrl) return null;
  try {
    const u = new URL(pageUrl);
    // /servers/<slug>
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts[0] === "servers" && parts[1]) return parts[1];
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * PulseMCP doesn't expose a product logo. Best signal is `external_url`
 * (rare but, when present, points at the real product page) → Clearbit. As a
 * fallback we use the GitHub owner avatar from `source_code_url`. Many MCPs
 * are official org repos (vendor matches the brand), so the avatar is often
 * acceptable. When the owner is a personal account it's a stranger's face,
 * but the user explicitly asked for any logo over a blank glyph.
 */
function deriveLogoUrl(raw: PulseMcpServer): string | null {
  const candidates = [raw.external_url, raw.url].filter(
    (u): u is string => typeof u === "string" && u.length > 0,
  );
  for (const candidate of candidates) {
    const domain = brandDomainFromUrl(candidate);
    if (domain) return `https://logo.clearbit.com/${domain}`;
  }
  return githubOwnerAvatar(raw.source_code_url ?? null);
}

function githubOwnerAvatar(source: string | null): string | null {
  if (!source) return null;
  try {
    const u = new URL(source);
    if (u.hostname !== "github.com") return null;
    const owner = u.pathname.split("/").filter(Boolean)[0];
    if (!owner) return null;
    return `https://avatars.githubusercontent.com/${owner}`;
  } catch {
    return null;
  }
}

/**
 * Pull a brand domain out of a homepage URL. Skips URLs that point at the
 * PulseMCP catalog itself (those don't represent the product) and at
 * github.com (those are repo URLs, not brand pages).
 */
function brandDomainFromUrl(href: string): string | null {
  try {
    const u = new URL(href);
    const host = u.hostname.toLowerCase();
    if (host === "github.com" || host.endsWith(".github.io")) return null;
    if (host === "pulsemcp.com" || host.endsWith(".pulsemcp.com")) return null;
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return null;
  }
}

function inferInstall(raw: PulseMcpServer): CatalogItem["install"] {
  // HTTP/SSE remote preferred when available.
  const remote = raw.remotes?.[0];
  if (remote?.url) {
    return { url: remote.url };
  }
  // Package-based stdio install.
  if (raw.package_registry === "npm" && raw.package_name) {
    return { command: "npx", args: ["-y", raw.package_name] };
  }
  if (raw.package_registry === "pypi" && raw.package_name) {
    return { command: "uvx", args: [raw.package_name] };
  }
  return undefined;
}
