import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** What a client needs to link Paperclip issue keys; the board token never leaves the daemon. */
export interface PaperclipLinks {
  webBaseUrl: string;
  prefixes: string[];
}

const CACHE_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5_000;
let cache: { home: string; at: number; links: PaperclipLinks | null } | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Company issue prefixes (VIZ, VIZA …) from the Paperclip board this host is connected to, read
 * with the board key in ~/.config/paperclip-paseo/board.json. Null when there is no board.
 */
export async function readPaperclipLinks(
  options: { home?: string; fetchImpl?: typeof fetch; now?: number } = {},
): Promise<PaperclipLinks | null> {
  const home = options.home ?? os.homedir();
  const now = options.now ?? Date.now();
  if (cache && cache.home === home && now - cache.at < CACHE_MS) return cache.links;
  let board: unknown;
  try {
    board = JSON.parse(
      await readFile(path.join(home, ".config", "paperclip-paseo", "board.json"), "utf8"),
    );
  } catch {
    cache = { home, at: now, links: null };
    return null;
  }
  if (!isRecord(board) || typeof board.apiBase !== "string" || typeof board.token !== "string") {
    cache = { home, at: now, links: null };
    return null;
  }
  const webBaseUrl = board.apiBase.replace(/\/+$/, "");
  const response = await (options.fetchImpl ?? fetch)(`${webBaseUrl}/api/companies`, {
    headers: { Authorization: `Bearer ${board.token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Paperclip answered ${response.status} for its companies`);
  const companies: unknown = await response.json();
  const prefixes = Array.isArray(companies)
    ? companies
        .map((company) => (isRecord(company) ? company.issuePrefix : null))
        .filter(
          (prefix): prefix is string =>
            typeof prefix === "string" && /^[A-Z][A-Z0-9]*$/.test(prefix),
        )
    : [];
  const links = { webBaseUrl, prefixes };
  cache = { home, at: now, links };
  return links;
}
