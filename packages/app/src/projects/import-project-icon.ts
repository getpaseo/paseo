import { Buffer } from "buffer";
import type { ProjectIconSource } from "@getpaseo/protocol/messages";

const MAX_ICON_BYTES = 512 * 1024;
const MAX_HTML_BYTES = 512 * 1024;
const MAX_ICON_CANDIDATES = 8;

type UploadSource = Extract<ProjectIconSource, { type: "upload" }>;
type FetchIcon = (input: string | URL, init?: RequestInit) => Promise<Response>;

function parseHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a valid website or image URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("URL must use HTTP or HTTPS without credentials");
  }
  return url;
}

async function fetchOk(fetchIcon: FetchIcon, url: URL): Promise<Response> {
  const response = await fetchIcon(url);
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  return response;
}

async function readBytes(response: Response, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("Icon must be 512 KB or smaller");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error("Icon must be 512 KB or smaller");
  return bytes;
}

function parseTagAttribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"));
  return match?.[1]?.trim() || null;
}

function iconCandidates(html: string, pageUrl: URL): URL[] {
  const candidates: URL[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = parseTagAttribute(tag, "rel")?.toLowerCase() ?? "";
    const href = parseTagAttribute(tag, "href");
    const type = parseTagAttribute(tag, "type")?.toLowerCase() ?? "";
    if (!href || !rel.includes("icon") || type.includes("svg") || href.endsWith(".svg")) continue;
    try {
      candidates.push(new URL(href, pageUrl));
    } catch {
      // Try the next declared icon and then the conventional fallback.
    }
  }
  candidates.push(new URL("/favicon.ico", pageUrl));
  return candidates.slice(0, MAX_ICON_CANDIDATES);
}

/** Acquires a URL on the client and collapses it into the normal upload payload. */
export async function importProjectIconFromUrl(
  value: string,
  fetchIcon: FetchIcon = fetch,
): Promise<UploadSource> {
  const url = parseHttpUrl(value.trim());
  const response = await fetchOk(fetchIcon, url);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";

  if (!contentType.includes("text/html")) {
    return { type: "upload", data: (await readBytes(response, MAX_ICON_BYTES)).toString("base64") };
  }

  const html = (await readBytes(response, MAX_HTML_BYTES)).toString("utf8");
  let lastError: unknown = new Error("Website does not expose a supported icon");
  for (const candidate of iconCandidates(html, url)) {
    try {
      const iconResponse = await fetchOk(fetchIcon, candidate);
      return {
        type: "upload",
        data: (await readBytes(iconResponse, MAX_ICON_BYTES)).toString("base64"),
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
