import { authServerFetch, authServerBaseUrl } from "./auth-server-fetch";
import type { LibrarySource, McpTransport } from "./library";

export interface CatalogItem {
  id: string;
  kind: "mcp" | "skill";
  name: string;
  description: string;
  iconUrl: string | null;
  homepage: string | null;
  transports?: McpTransport[];
  install?: {
    command?: string;
    args?: string[];
    url?: string;
    headers?: Record<string, string>;
    envVars?: string[];
  };
  instructionsUrl?: string;
  examplePrompt?: string;
  popularity?: number;
  source: LibrarySource | "pulsemcp" | "anthropic-skills" | "openai-skills" | "skills-sh";
}

export interface CatalogPage {
  items: CatalogItem[];
  nextCursor: string | null;
  totalCount: number;
}

async function request<T>(path: string, sessionToken: string | null): Promise<T> {
  const res = await authServerFetch(path, {
    method: "GET",
    sessionToken,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function fetchMcpCatalog(args: {
  sessionToken: string | null;
  query?: string;
  cursor?: string;
  refresh?: boolean;
}): Promise<CatalogPage> {
  const qs = new URLSearchParams();
  if (args.query) qs.set("q", args.query);
  if (args.cursor) qs.set("cursor", args.cursor);
  if (args.refresh) qs.set("refresh", "1");
  return request<CatalogPage>(
    `/api/catalog/mcp${qs.toString() ? `?${qs}` : ""}`,
    args.sessionToken,
  );
}

/**
 * Resolve connection details (URL or command/args + env var schema) for a
 * single catalog item. Used by AddMcpModal so we don't pay the detail cost
 * for every card on the list screen.
 */
export async function fetchMcpCatalogDetail(args: {
  sessionToken: string | null;
  id: string;
}): Promise<CatalogItem | null> {
  try {
    const body = await request<{ item: CatalogItem }>(
      `/api/catalog/mcp/${encodeURIComponent(args.id)}`,
      args.sessionToken,
    );
    return body.item;
  } catch {
    return null;
  }
}

export async function fetchSkillsCatalog(args: {
  sessionToken: string | null;
  query?: string;
  refresh?: boolean;
}): Promise<CatalogPage> {
  const qs = new URLSearchParams();
  if (args.query) qs.set("q", args.query);
  if (args.refresh) qs.set("refresh", "1");
  return request<CatalogPage>(
    `/api/catalog/skills${qs.toString() ? `?${qs}` : ""}`,
    args.sessionToken,
  );
}

export async function fetchSkillBody(args: {
  sessionToken: string | null;
  url: string;
}): Promise<string> {
  const qs = new URLSearchParams({ url: args.url });
  const body = await request<{ body: string }>(`/api/catalog/skills/body?${qs}`, args.sessionToken);
  return body.body;
}

/**
 * Build the public icon-proxy URL. Used directly as `<img src>` / `<Image
 * source>` since the endpoint is unauthenticated and serves from cache.
 */
export function catalogIconUrl(sourceUrl: string | null): string | null {
  if (!sourceUrl) return null;
  const qs = new URLSearchParams({ url: sourceUrl });
  return `${authServerBaseUrl()}/api/catalog/icon?${qs}`;
}
