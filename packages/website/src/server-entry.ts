import startEntry from "@tanstack/react-start/server-entry";
import { getAndroidVersionCode } from "~/android-version";
import { getCanonicalRedirect } from "~/canonical-url";
import { getDoc, getLegacyDocsRedirect } from "~/docs";
import { getLatestAndroidVersion } from "~/latest-release";
import { buildLlmsTxt } from "~/llms";

interface WebsiteEnv {
  WEBSITE_CACHE?: KVNamespace;
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

function docSlugFromMarkdownPath(pathname: string): string | null {
  if (pathname === "/docs.md") return "";
  const match = pathname.match(/^\/docs\/(.+)\.md$/);
  return match ? match[1] : null;
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

export default {
  async fetch(request: Request, env: WebsiteEnv, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    const environment = import.meta.env.DEV ? "development" : "production";
    const canonicalRedirect = getCanonicalRedirect(url, environment);
    if (canonicalRedirect) {
      return Response.redirect(canonicalRedirect, 301);
    }

    if (url.pathname === "/cloud" || url.pathname === "/cloud/") {
      url.pathname = "/hub";
      return Response.redirect(url.toString(), 301);
    }

    const altRedirectMatch = url.pathname.match(/^\/docs\/alternatives\/(.+?)\/?$/);
    if (altRedirectMatch) {
      url.pathname = `/alternatives/${altRedirectMatch[1]}`;
      return Response.redirect(url.toString(), 301);
    }

    const legacyDocsRedirect = getLegacyDocsRedirect(url.pathname);
    if (legacyDocsRedirect) {
      url.pathname = legacyDocsRedirect;
      return Response.redirect(url.toString(), 301);
    }

    if (url.pathname === "/llms.txt") {
      return markdownResponse(buildLlmsTxt());
    }

    if (url.pathname === "/android-version.txt") {
      const version = await getLatestAndroidVersion({
        cache: env.WEBSITE_CACHE ?? null,
        waitUntil: (promise) => context.waitUntil(promise),
      });
      return plainTextResponse(`${getAndroidVersionCode(version)}\n`);
    }

    const slug = docSlugFromMarkdownPath(url.pathname);
    if (slug !== null) {
      const doc = getDoc(slug);
      if (!doc) return new Response("Not found", { status: 404 });
      return markdownResponse(doc.content);
    }

    const response = await startEntry.fetch(request);
    return variesByUserAgent(url.pathname, response) ? withoutSharedCaching(response) : response;
  },
};
