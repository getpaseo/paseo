import type { CatalogItem, CatalogPage } from "./types";

/**
 * Smithery MCP registry adapter (registry.smithery.ai).
 *
 * Chosen over PulseMCP because listings already carry:
 *   - real product icons (`iconUrl` from their CDN)
 *   - `configSchema` per connection with required env vars + descriptions
 *   - usable remote endpoints (`deploymentUrl`) for HTTP servers
 *   - install command convention via `@smithery/cli` for stdio servers
 *
 * Auth: `SMITHERY_API_KEY` is optional for listing/detail but recommended
 * to avoid rate limits. Passed as `Authorization: Bearer <token>`.
 */

const REGISTRY_BASE = "https://registry.smithery.ai";
const DEFAULT_PAGE_SIZE = 50;

interface SmitheryListItem {
  id: string;
  qualifiedName: string;
  namespace?: string | null;
  slug?: string | null;
  displayName: string;
  description?: string | null;
  iconUrl?: string | null;
  verified?: boolean;
  useCount?: number;
  remote?: boolean;
  isDeployed?: boolean;
  createdAt?: string;
  homepage?: string | null;
  owner?: string | null;
  score?: number | null;
}

interface SmitheryListResponse {
  servers?: SmitheryListItem[];
  pagination?: {
    currentPage: number;
    pageSize: number;
    totalPages: number;
    totalCount: number;
  };
}

interface SmitheryConnection {
  type: "stdio" | "http" | "sse";
  deploymentUrl?: string;
  configSchema?: Record<string, unknown>;
}

interface SmitheryDetail extends SmitheryListItem {
  deploymentUrl?: string;
  connections?: SmitheryConnection[];
  tools?: unknown[];
}

export interface FetchSmitheryParams {
  query?: string;
  /** 1-indexed page number matching Smithery's pagination. */
  page?: number;
  pageSize?: number;
}

export async function fetchSmitheryCatalog(params: FetchSmitheryParams): Promise<CatalogPage> {
  const url = new URL(`${REGISTRY_BASE}/servers`);
  if (params.query) url.searchParams.set("q", params.query);
  url.searchParams.set("page", String(params.page ?? 1));
  url.searchParams.set("pageSize", String(params.pageSize ?? DEFAULT_PAGE_SIZE));

  const res = await fetch(url.toString(), {
    headers: headers(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Smithery ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as SmitheryListResponse;
  const items: CatalogItem[] = (body.servers ?? []).map(normalizeList);
  const next =
    body.pagination && body.pagination.currentPage < body.pagination.totalPages
      ? String(body.pagination.currentPage + 1)
      : null;
  return {
    items,
    nextCursor: next,
    totalCount: body.pagination?.totalCount ?? items.length,
  };
}

/**
 * Detail fetch is where `connections[].configSchema` lives. Called lazily
 * when the user opens the Add modal for a catalog item.
 */
export async function fetchSmitheryDetail(qualifiedName: string): Promise<SmitheryDetail | null> {
  const res = await fetch(
    `${REGISTRY_BASE}/servers/${encodeURIComponent(qualifiedName)}`,
    { headers: headers(), signal: AbortSignal.timeout(15_000) },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Smithery detail ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as SmitheryDetail;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" };
  const token = process.env.SMITHERY_API_KEY?.trim();
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function normalizeList(raw: SmitheryListItem): CatalogItem {
  const id = `smithery:${raw.qualifiedName}`;
  const isRemote = raw.remote === true;
  const transports: Array<"stdio" | "http" | "sse"> = isRemote ? ["http"] : ["stdio"];

  return {
    id,
    kind: "mcp",
    name: raw.qualifiedName,
    description: raw.description ?? "",
    iconUrl: raw.iconUrl ?? null,
    homepage: raw.homepage ?? null,
    transports,
    // We leave `install` undefined here — enriched on demand via `enrichWithDetail`
    // once the user opens the Add modal. Saves ~4800 detail fetches on list load.
    popularity: raw.useCount ?? 0,
    source: "smithery",
  };
}

/**
 * Expand a list CatalogItem with the connection info from the detail endpoint.
 * Used by the MCP route when the user asks for a specific catalog item.
 */
export async function enrichFromSmitheryDetail(
  item: CatalogItem,
): Promise<CatalogItem> {
  if (!item.id.startsWith("smithery:")) return item;
  const qualifiedName = item.id.slice("smithery:".length);
  const detail = await fetchSmitheryDetail(qualifiedName).catch(() => null);
  if (!detail) return item;

  const stdio = detail.connections?.find((c) => c.type === "stdio");
  const http = detail.connections?.find((c) => c.type === "http" || c.type === "sse");
  const preferred = http ?? stdio;

  const envVarsFromSchema = preferred?.configSchema
    ? extractRequiredEnvVars(preferred.configSchema)
    : [];

  if (preferred?.type === "http" || preferred?.type === "sse") {
    const url = preferred.deploymentUrl ?? detail.deploymentUrl;
    if (url) {
      item.install = {
        url,
        ...(envVarsFromSchema.length > 0 ? { envVars: envVarsFromSchema } : {}),
      };
      item.transports = [preferred.type];
    }
  } else if (preferred?.type === "stdio") {
    // Smithery's convention is to run stdio servers via `@smithery/cli`, which
    // resolves the actual package and configSchema at runtime. Users still
    // need to supply the schema-declared env vars.
    item.install = {
      command: "npx",
      args: ["-y", "@smithery/cli@latest", "run", qualifiedName],
      ...(envVarsFromSchema.length > 0 ? { envVars: envVarsFromSchema } : {}),
    };
    item.transports = ["stdio"];
  }

  return item;
}

function extractRequiredEnvVars(schema: Record<string, unknown>): string[] {
  const required = new Set<string>();
  const reqList = schema.required;
  if (Array.isArray(reqList)) {
    for (const key of reqList) {
      if (typeof key === "string") required.add(key);
    }
  }
  const props = schema.properties;
  if (props && typeof props === "object") {
    for (const key of Object.keys(props)) {
      required.add(key);
    }
  }
  // Return in schema-declared order (Smithery keeps `properties` ordered).
  return Array.from(required);
}
