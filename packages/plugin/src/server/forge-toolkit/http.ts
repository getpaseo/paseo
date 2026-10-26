import type { z } from "zod";
import { ForgeAuthenticationError, ForgeCommandError } from "../../forge.js";

/**
 * Token-authenticated REST transport for Forge plugins that talk to a vendor
 * API directly instead of driving a CLI.
 *
 * It exists so a plugin only writes endpoint shapes. The parts that are the
 * same for every forge live here: token resolution, timeout, redaction, and the
 * mapping from HTTP status onto the SDK's classified Forge errors. The daemon
 * derives auth state from those error classes alone, so a plugin that throws a
 * bare `Error` on a 401 shows the user "error" instead of "not signed in".
 */
export type ForgeHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type ForgeHttpQuery = Record<string, string | number | boolean | null | undefined>;

export interface ForgeHttpRawRequest {
  /** Repository directory the call is made for. Surfaces in classified errors. */
  cwd: string;
  /** Path appended to `baseUrl`, e.g. `/repos/acme/app/pulls`. */
  path: string;
  method?: ForgeHttpMethod;
  query?: ForgeHttpQuery;
  /** Serialized as JSON unless it is already a string. */
  body?: unknown;
  headers?: Record<string, string>;
  /** Query keys whose values are replaced before the call appears in an error. */
  redactQueryKeys?: readonly string[];
}

export interface ForgeHttpRequest<T> extends ForgeHttpRawRequest {
  schema: z.ZodType<T>;
}

export interface ForgeHttpResponse {
  status: number;
  headers: Headers;
  text: string;
}

export interface CreateForgeHttpClientOptions {
  /** Brand shown in classified errors, e.g. "Acme". */
  brand: string;
  /** Absolute API root, e.g. `https://acme.test/api/v5`. */
  baseUrl: string;
  /**
   * Resolves the access token, or null when the user has not configured one.
   * Read it from the plugin's secret store, never from plugin settings: settings
   * values are served to every connected client over `settings.<id>.read`.
   */
  resolveToken: () => Promise<string | null>;
  /** Defaults to an `Authorization: Bearer <token>` header. */
  applyToken?: (token: string, request: { url: URL; headers: Headers }) => void;
  timeoutMs?: number;
  userAgent?: string;
  /** Statuses treated as an auth failure. Defaults to 401 and 403. */
  isAuthFailureStatus?: (status: number) => boolean;
  /** Injection point for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface ForgeHttpClient {
  /** Sends the request and parses the JSON body through `schema`. */
  request<T>(request: ForgeHttpRequest<T>): Promise<T>;
  /** Sends the request and returns the raw body, for pagination headers or empty responses. */
  send(request: ForgeHttpRawRequest): Promise<ForgeHttpResponse>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const REDACTED_VALUE = "<redacted>";

export function createForgeHttpClient(options: CreateForgeHttpClientOptions): ForgeHttpClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const isAuthFailureStatus =
    options.isAuthFailureStatus ?? ((status: number) => status === 401 || status === 403);
  const applyToken =
    options.applyToken ??
    ((token: string, request: { headers: Headers }) => {
      request.headers.set("authorization", `Bearer ${token}`);
    });
  const label = {
    brand: options.brand,
    binary: safeHost(options.baseUrl),
    kind: "request" as const,
  };

  function commandError(request: ForgeHttpRawRequest, exitCode: number | null, stderr: string) {
    return new ForgeCommandError(label, {
      args: describeRequest(request),
      cwd: request.cwd,
      exitCode,
      stderr,
    });
  }

  async function send(request: ForgeHttpRawRequest): Promise<ForgeHttpResponse> {
    const token = await options.resolveToken();
    if (!token) {
      throw new ForgeAuthenticationError(`${options.brand} has no access token configured`, {
        stderr: "",
      });
    }
    const url = buildUrl(options.baseUrl, request.path, request.query);
    const headers = new Headers({ accept: "application/json" });
    if (options.userAgent) headers.set("user-agent", options.userAgent);
    for (const [key, value] of Object.entries(request.headers ?? {})) headers.set(key, value);
    let body: string | undefined;
    if (request.body !== undefined) {
      body = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }
    applyToken(token, { url, headers });

    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: request.method ?? "GET",
        headers,
        ...(body === undefined ? {} : { body }),
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = controller.signal.aborted;
      throw commandError(
        request,
        null,
        aborted ? `${options.brand} request timed out after ${timeoutMs}ms` : toMessage(error),
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text().catch(() => "");
    if (isAuthFailureStatus(response.status)) {
      throw new ForgeAuthenticationError(
        `${options.brand} rejected the request (HTTP ${response.status})`,
        { stderr: text },
      );
    }
    if (!response.ok) {
      throw commandError(request, response.status, text || `HTTP ${response.status}`);
    }
    return { status: response.status, headers: response.headers, text };
  }

  return {
    send,
    async request<T>(request: ForgeHttpRequest<T>): Promise<T> {
      const response = await send(request);
      // An empty body parses as `undefined` so a 204 endpoint can declare
      // `z.undefined()` instead of every caller checking the body length.
      let data: unknown;
      if (response.text.trim().length === 0) {
        data = undefined;
      } else {
        try {
          data = JSON.parse(response.text);
        } catch {
          throw commandError(
            request,
            response.status,
            `${options.brand} did not return valid JSON (${response.text.length} bytes)`,
          );
        }
      }
      const parsed = request.schema.safeParse(data);
      if (!parsed.success) {
        throw commandError(
          request,
          response.status,
          `${options.brand} JSON did not match the expected schema: ${parsed.error.message}`,
        );
      }
      return parsed.data;
    },
  };
}

/** Reads the first non-empty environment variable from `names`. */
export function resolveTokenFromEnv(
  names: readonly string[],
  env: Record<string, string | undefined> = process.env,
): string | null {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return null;
}

export function buildUrl(baseUrl: string, path: string, query?: ForgeHttpQuery): URL {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL(path.replace(/^\/+/u, ""), base);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

function describeRequest(request: ForgeHttpRawRequest): string[] {
  const redact = new Set(request.redactQueryKeys ?? []);
  const query = Object.entries(request.query ?? {})
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${redact.has(key) ? REDACTED_VALUE : String(value)}`)
    .join("&");
  return [request.method ?? "GET", query ? `${request.path}?${query}` : request.path];
}

function safeHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
