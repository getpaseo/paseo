import { pluginMediaKind } from "@getpaseo/protocol/plugin-registry";
import type { Plugin } from "./registry";

// The single-column grid reaches 591px just below sm (640px minus 48px padding).
const CARD_WIDTH = 592;
const WIDTHS = new Set([CARD_WIDTH, CARD_WIDTH * 2]);
const SOURCE_HOSTS = new Set(["cdn.jsdelivr.net", "raw.githubusercontent.com"]);

export function pluginCardScreenshot(id: string, source: string): { src: string; srcSet?: string } {
  if (!parseSource(source)) return { src: source };
  return {
    src: pluginThumbnailUrl(id, source, 1),
    srcSet: `${pluginThumbnailUrl(id, source, 1)} 1x, ${pluginThumbnailUrl(id, source, 2)} 2x`,
  };
}

function pluginThumbnailUrl(id: string, source: string, scale: 1 | 2): string {
  return `/plugins/thumb/${CARD_WIDTH * scale}/${encodeURIComponent(source)}?plugin=${encodeURIComponent(id)}`;
}

/** Only images listed in the plugin's media are eligible for transformation or original fallback. */
export async function handlePluginThumbnailRequest(
  request: Request,
  plugins: Plugin[],
  fetchImage: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(request.url);
  const match = /^\/plugins\/thumb\/(\d+)\/([^/]+)$/.exec(url.pathname);
  if (!match || !WIDTHS.has(Number(match[1])))
    return new Response("Invalid thumbnail width or source", { status: 400 });

  let decoded: string;
  try {
    decoded = decodeURIComponent(match[2]);
  } catch {
    return new Response("Invalid thumbnail source", { status: 400 });
  }
  const source = parseSource(decoded);
  if (!source) return new Response("Invalid thumbnail source", { status: 400 });

  const plugin = plugins.find((entry) => entry.id === url.searchParams.get("plugin"));
  if (!plugin?.media.includes(source) || pluginMediaKind(source) !== "image")
    return new Response("Screenshot not found", { status: 404 });

  const format = negotiatedFormat(request.headers.get("accept") ?? "");
  let response: Response | undefined;
  try {
    response = await fetchImage(source, {
      cf: { image: { width: Number(match[1]), fit: "scale-down", format, quality: 80 } },
    });
  } catch {
    // An unavailable transformation must not prevent fetching the original.
  }
  if (!response || !isImage(response) || /err=/i.test(response.headers.get("cf-resized") ?? "")) {
    await response?.body?.cancel();
    try {
      response = await fetchImage(source);
    } catch {
      return unavailableImage();
    }
  }
  if (!isImage(response)) {
    await response.body?.cancel();
    return unavailableImage();
  }
  return new Response(response.body, {
    headers: {
      "content-type": response.headers.get("content-type")!,
      "cache-control": "public, max-age=31536000, immutable",
      vary: "Accept",
      // Originals can be SVGs. Keep direct navigation from executing them on our origin.
      "content-security-policy": "sandbox",
      "x-content-type-options": "nosniff",
    },
  });
}

function isImage(response: Response): boolean {
  return response.ok && /^image\//i.test(response.headers.get("content-type") ?? "");
}

function unavailableImage(): Response {
  return new Response("Screenshot unavailable", {
    status: 502,
    headers: { "cache-control": "no-store" },
  });
}

function parseSource(source: string): string | null {
  try {
    const url = new URL(source);
    if (
      url.protocol !== "https:" ||
      !SOURCE_HOSTS.has(url.hostname) ||
      url.username ||
      url.password ||
      url.port
    )
      return null;
    return source;
  } catch {
    return null;
  }
}

function negotiatedFormat(accept: string): "avif" | "webp" | undefined {
  // The Worker API requires explicit negotiation; only the URL API accepts format=auto.
  const accepted = new Map(
    accept
      .toLowerCase()
      .split(",")
      .map((range) => {
        const [type, ...parameters] = range.split(";").map((part) => part.trim());
        const quality = parameters.find((parameter) => parameter.startsWith("q="));
        return [type, quality === undefined ? 1 : Number(quality.slice(2))] as const;
      }),
  );
  return (["avif", "webp"] as const).find((format) => (accepted.get(`image/${format}`) ?? 0) > 0);
}
