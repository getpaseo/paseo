import { handlePluginRegistryRequest } from "~/plugins/published";
import type { Register } from "@tanstack/react-router";
import type { RequestHandler } from "@tanstack/react-start/server";
import { getAndroidVersionCode } from "~/android-version";
import { getCanonicalRedirect } from "~/canonical-url";
import { getLegacyDocsRedirect, resolveDocMarkdownPath } from "~/docs";
import { splitLocalePath, withLocalePrefix } from "~/i18n";
import { getLatestAndroidVersion } from "~/latest-release";
import { buildLlmsTxt } from "~/llms";

interface WebsiteEnv {
  WEBSITE_CACHE?: KVNamespace;
  PLUGINS_REGISTRY_URL?: string;
}

function markdownResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "public, max-age=300, s-maxage=300",
    },
  });
}

function plainTextResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=300, s-maxage=300",
    },
  });
}

/**
 * SSR reads the request user agent to pick the download call to action (see
 * `~/platform`), so two visitors on the same URL get different markup. Nothing
 * caches these responses today — the zone cache sits behind the Worker and
 * Workers Cache is off — but an absent `cache-control` is not `no-store`: a
 * shared cache may assign heuristic freshness (RFC 9111 §4.2.2), and enabling
 * Workers Cache would store a headerless 200 for two hours under a key that
 * ignores `user-agent`. Either way one Android visitor could pin the Play Store
 * button for every Mac visitor after them.
 *
 * `private` is what actually stops that. `Vary` records the contract so a
 * compliant cache stays correct if the policy is ever loosened. Static assets
 * never reach this Worker, so their long-lived `_headers` rules are untouched.
 */
function withoutSharedCaching(response: Response): Response {
  const result = new Response(response.body, response);
  result.headers.set("cache-control", "private, no-store");
  result.headers.set("vary", "user-agent");
  return result;
}

function variesByUserAgent(pathname: string, response: Response): boolean {
  if (pathname.startsWith("/_serverFn/")) return true;
  return response.headers.get("content-type")?.includes("text/html") ?? false;
}

// A static import of TanStack Start's server handler breaks every SSR hot reload on
// Vite 7 with "createStartHandler is not a function". Importing it at request time
// avoids the race. Remove once the website is on a Vite release with vitejs/vite#22369.
// https://github.com/TanStack/router/issues/7285
let cachedStartFetch: RequestHandler<Register> | null = null;

async function getStartFetch(): Promise<RequestHandler<Register>> {
  if (!cachedStartFetch) {
    const { createStartHandler, defaultStreamHandler } =
      await import("@tanstack/react-start/server");
    cachedStartFetch = createStartHandler(defaultStreamHandler);
  }
  return cachedStartFetch;
}

function getRetiredPathRedirect(path: string): string | undefined {
  if (path === "/cloud" || path === "/cloud/") return "/hub";
  const alternative = /^\/docs\/alternatives\/(.+?)\/?$/.exec(path);
  if (alternative) return `/alternatives/${alternative[1]}`;
  return getLegacyDocsRedirect(path);
}

export default {
  async fetch(request: Request, env: WebsiteEnv, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    const pluginResponse = await handlePluginRegistryRequest(request, env, {
      cache: env.WEBSITE_CACHE ?? null,
      waitUntil: (promise) => context.waitUntil(promise),
    });
    if (pluginResponse) return pluginResponse;

    const environment = import.meta.env.DEV ? "development" : "production";
    const canonicalRedirect = getCanonicalRedirect(url, environment);
    if (canonicalRedirect) {
      return Response.redirect(canonicalRedirect, 301);
    }

    // Retired paths redirect in every language: `/zh-CN/cloud` lands on `/zh-CN/hub`.
    const { locale, path } = splitLocalePath(url.pathname);
    const retiredPath = getRetiredPathRedirect(path);
    if (retiredPath) {
      url.pathname = withLocalePrefix(retiredPath, locale);
      return Response.redirect(url.toString(), 301);
    }

    if (path === "/llms.txt") {
      return markdownResponse(buildLlmsTxt(locale));
    }

    if (url.pathname === "/android-version.txt") {
      const version = await getLatestAndroidVersion({
        cache: env.WEBSITE_CACHE ?? null,
        waitUntil: (promise) => context.waitUntil(promise),
      });
      return plainTextResponse(`${getAndroidVersionCode(version)}\n`);
    }

    const markdown = resolveDocMarkdownPath(url.pathname);
    if (markdown) {
      if (!markdown.doc) return new Response("Not found", { status: 404 });
      return markdownResponse(markdown.doc.content);
    }

    const startFetch = await getStartFetch();
    const response = await startFetch(request);
    return variesByUserAgent(url.pathname, response) ? withoutSharedCaching(response) : response;
  },
};
