import { createReadStream, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { RequestHandler, Response } from "express";
import type { Logger } from "pino";

const EXCLUDED_PATH_PREFIXES = ["/api/", "/mcp/", "/public/"];
const EXCLUDED_PATHS = new Set(["/api", "/mcp", "/public"]);

function isExcludedPath(requestPath: string): boolean {
  for (const prefix of EXCLUDED_PATH_PREFIXES) {
    if (requestPath.startsWith(prefix)) {
      return true;
    }
  }
  return EXCLUDED_PATHS.has(requestPath);
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".map": "application/json",
};

function getContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

function selectEncoding(acceptEncoding: string | undefined): "br" | "gzip" | null {
  if (!acceptEncoding) {
    return null;
  }
  const normalized = acceptEncoding.toLowerCase();
  if (normalized.includes("br")) {
    return "br";
  }
  if (normalized.includes("gzip")) {
    return "gzip";
  }
  return null;
}

function isHashedAsset(filePath: string): boolean {
  const base = path.basename(filePath);
  // Match content hashes like index-abc123def456.js or main.abc123def456.css.
  return /[-.][0-9a-f]{16,}[-.]/i.test(base);
}

function isInsideDir(targetPath: string, dirPath: string): boolean {
  const resolvedDir = path.resolve(dirPath);
  const resolvedTarget = path.resolve(targetPath);
  return resolvedTarget === resolvedDir || resolvedTarget.startsWith(resolvedDir + path.sep);
}

interface ResolvedTarget {
  resolvedFile: string;
  isIndexHtml: boolean;
}

function resolveTargetFile(distDir: string, requestPath: string): ResolvedTarget | null {
  const safePath = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
  let filePath = path.join(distDir, safePath);

  const stat = safeStat(filePath);
  if (stat?.isDirectory()) {
    filePath = path.join(filePath, "index.html");
  }

  const finalStat = safeStat(filePath);
  if (!finalStat?.isFile()) {
    filePath = path.join(distDir, "index.html");
    const fallbackStat = safeStat(filePath);
    if (!fallbackStat?.isFile()) {
      return null;
    }
  }

  if (!isInsideDir(filePath, distDir)) {
    return null;
  }

  const resolvedFile = path.resolve(filePath);
  const isIndexHtml = path.basename(resolvedFile).toLowerCase() === "index.html";
  return { resolvedFile, isIndexHtml };
}

function safeStat(filePath: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(filePath);
  } catch {
    return null;
  }
}

interface ContentEncodingResult {
  finalFile: string;
  contentEncoding: string | null;
}

function resolveContentEncoding(
  resolvedFile: string,
  acceptEncoding: string | undefined,
): ContentEncodingResult {
  const encoding = selectEncoding(acceptEncoding);
  if (!encoding) {
    return { finalFile: resolvedFile, contentEncoding: null };
  }
  const compressedFile = `${resolvedFile}.${encoding === "br" ? "br" : "gz"}`;
  const compressedStat = safeStat(compressedFile);
  if (compressedStat?.isFile()) {
    return { finalFile: compressedFile, contentEncoding: encoding };
  }
  return { finalFile: resolvedFile, contentEncoding: null };
}

function setResponseCacheHeaders(res: Response, isIndexHtml: boolean, resolvedFile: string): void {
  if (isIndexHtml) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  } else if (isHashedAsset(resolvedFile)) {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  } else {
    res.setHeader("Cache-Control", "no-cache");
  }
}

export interface WebUiMiddlewareOptions {
  enabled: boolean;
  distDir: string | null;
  label: string;
  logger: Logger;
}

export function createWebUiMiddleware(options: WebUiMiddlewareOptions): RequestHandler {
  const { enabled, distDir, label, logger } = options;
  const childLogger = logger.child({ module: "web-ui" });

  if (!enabled || !distDir) {
    childLogger.info(
      { enabled, hasDistDir: !!distDir },
      "Daemon web UI disabled or missing dist directory",
    );
  } else {
    childLogger.info({ distDir }, "Daemon web UI mounted");
  }

  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }

    if (isExcludedPath(req.path)) {
      next();
      return;
    }

    if (!enabled || !distDir) {
      res.status(404).end();
      return;
    }

    serveWebUiFile({ distDir, requestPath: req.path, label, req, res });
  };
}

interface ServeWebUiFileOptions {
  distDir: string;
  requestPath: string;
  label: string;
  req: Parameters<RequestHandler>[0];
  res: Parameters<RequestHandler>[1];
}

function serveWebUiFile(options: ServeWebUiFileOptions): void {
  const { distDir, requestPath, label, req, res } = options;

  const target = resolveTargetFile(distDir, requestPath);
  if (!target) {
    res.status(404).end();
    return;
  }

  const { resolvedFile, isIndexHtml } = target;
  const acceptEncoding = isIndexHtml ? undefined : req.headers["accept-encoding"];
  const { finalFile, contentEncoding } = resolveContentEncoding(resolvedFile, acceptEncoding);

  res.setHeader("Content-Type", getContentType(resolvedFile));
  if (contentEncoding) {
    res.setHeader("Content-Encoding", contentEncoding);
    res.setHeader("Vary", "Accept-Encoding");
  }
  setResponseCacheHeaders(res, isIndexHtml, resolvedFile);

  if (req.method === "HEAD") {
    res.status(200).end();
    return;
  }

  if (isIndexHtml) {
    sendIndexHtml(res, finalFile, req, label);
    return;
  }

  const stream = createReadStream(finalFile);
  stream.on("error", () => {
    if (!res.headersSent) {
      res.status(500).end();
    } else {
      res.end();
    }
  });
  stream.pipe(res);
}

function sendIndexHtml(
  res: Response,
  filePath: string,
  req: Parameters<RequestHandler>[0],
  label: string,
): void {
  try {
    const html = readFileSync(filePath, "utf-8");
    const injected = injectConnectionHint(html, req, label);
    res.status(200).send(injected);
  } catch {
    res.status(500).end();
  }
}

function serializeInlineScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003C")
    .replace(/>/g, "\\u003E")
    .replace(/&/g, "\\u0026");
}

function injectConnectionHint(
  html: string,
  req: Parameters<RequestHandler>[0],
  label: string,
): string {
  const host = typeof req.headers.host === "string" ? req.headers.host : "";
  const useTls = req.protocol === "https";
  const hint = {
    listen: host,
    useTls,
    label,
  };
  const script = `<script>window.__PASEO_INITIAL_DAEMON_CONNECTION__=${serializeInlineScriptJson(hint)}</script>`;
  const headClose = /<\/head>/i;
  if (headClose.test(html)) {
    return html.replace(headClose, `${script}</head>`);
  }
  return script + html;
}
