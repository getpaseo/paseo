import startEntry from "@tanstack/react-start/server-entry";
import { getAndroidVersionCode } from "~/android-version";
import { getDoc } from "~/docs";
import { getLatestAndroidVersion } from "~/latest-release";
import { buildLlmsTxt } from "~/llms";

const CANONICAL_HOST = "paseo.sh";

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

export default {
  async fetch(request: Request, env: WebsiteEnv, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (!isLocal && (url.hostname !== CANONICAL_HOST || url.protocol !== "https:")) {
      url.protocol = "https:";
      url.hostname = CANONICAL_HOST;
      return Response.redirect(url.toString(), 301);
    }

    const altRedirectMatch = url.pathname.match(/^\/docs\/alternatives\/(.+?)\/?$/);
    if (altRedirectMatch) {
      url.pathname = `/alternatives/${altRedirectMatch[1]}`;
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

    return startEntry.fetch(request);
  },
};
