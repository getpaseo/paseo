import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { handlePluginThumbnailRequest, pluginCardScreenshot } from "./thumbnails";
import { NewPluginCard, PluginCard } from "./plugin-card";
import type { Plugin } from "./registry";

const source = "https://cdn.jsdelivr.net/npm/paseo-example@1.2.3/preview.png";
const video = "https://cdn.jsdelivr.net/npm/paseo-example@1.2.3/demo.mp4";
const plugin: Plugin = {
  id: "acme/example",
  name: "Example",
  description: "An example",
  categories: ["themes"],
  author: { github: "acme" },
  repository: { url: "https://github.com/acme/example" },
  artifact: {
    kind: "npm",
    package: "paseo-example",
    version: "1.2.3",
    resolved: "https://registry.npmjs.org/example.tgz",
    integrity: "sha512-YWJj",
  },
  media: [source],
  submittedAt: "2026-10-03",
  reviewedAt: "2026-10-03",
  updatedAt: "2026-10-03",
  publishedAt: "2026-10-03",
  installs: 42,
};

describe("plugin card thumbnails", () => {
  it("uses the first image in the plugin's media, skipping a leading video", () => {
    const html = renderToStaticMarkup(
      createElement(PluginCard, { plugin: { ...plugin, media: [video, source] } }),
    );
    expect(html).toContain(`/plugins/thumb/592/${encodeURIComponent(source)}?`);
    expect(html).not.toContain(encodeURIComponent(video));
  });

  it("shows the plugin tile when the media has no image", () => {
    const html = renderToStaticMarkup(
      createElement(PluginCard, { plugin: { ...plugin, media: [video] } }),
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<video");
    expect(html).toContain(">E</div>");
  });

  it("keeps a screenshot on an unsupported host visible at its original URL", () => {
    const screenshot = "https://example.com/preview.png";
    const html = renderToStaticMarkup(
      createElement(PluginCard, { plugin: { ...plugin, media: [screenshot] } }),
    );
    expect(html).toContain(`src="${screenshot}"`);
    expect(html).not.toContain("/plugins/thumb/");
  });

  it.each([
    ["PluginCard", () => createElement(PluginCard, { plugin }, "today")],
    ["NewPluginCard", () => createElement(NewPluginCard, { plugin }, "today")],
  ])("renders a thumbnail instead of downloading the original screenshot (%s)", (_name, card) => {
    const html = renderToStaticMarkup(card());
    expect(html).toContain(
      `src="/plugins/thumb/592/${encodeURIComponent(source)}?plugin=acme%2Fexample"`,
    );
    expect(html).toContain(
      `srcSet="/plugins/thumb/592/${encodeURIComponent(source)}?plugin=acme%2Fexample 1x, /plugins/thumb/1184/${encodeURIComponent(source)}?plugin=acme%2Fexample 2x"`,
    );
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
  });
});

function thumbnailRequest(
  sourceUrl = source,
  width = 592,
  id = plugin.id,
  accept = "image/avif,image/webp",
) {
  return new Request(
    `https://paseo.sh/plugins/thumb/${width}/${encodeURIComponent(sourceUrl)}?plugin=${encodeURIComponent(id)}`,
    { headers: { accept } },
  );
}

function imageResponse(body: string, headers: Record<string, string> = {}) {
  return new Response(body, { headers: { "content-type": "image/png", ...headers } });
}

// A typed fetch dependency, returning real Responses without patching the global fetch.
function imageFetch(...responses: (Response | Error)[]) {
  const calls: { input: Parameters<typeof fetch>[0]; init: Parameters<typeof fetch>[1] }[] = [];
  const fetchImage: typeof fetch = async (input, init) => {
    calls.push({ input, init });
    const response = responses.shift();
    if (!response) throw new Error("Unexpected fetch");
    if (response instanceof Error) throw response;
    return response;
  };
  return { calls, fetchImage };
}

describe("thumbnail route", () => {
  it("sandboxes an SVG fallback when opened as a document on the website origin", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>';
    const upstream = imageFetch(
      new Response("unsupported", { status: 415 }),
      imageResponse(svg, { "content-type": "image/svg+xml" }),
    );
    const response = await handlePluginThumbnailRequest(
      thumbnailRequest(),
      [plugin],
      upstream.fetchImage,
    );
    expect(await response.text()).toBe(svg);
    expect(response.headers.get("content-security-policy")).toBe("sandbox");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it.each([
    [592, source, "image/avif,image/webp", "avif"],
    [592, source, "image/avif;q=0,image/webp", "webp"],
    [592, source, "image/avif;q=0,image/webp;q=0", undefined],
    [
      1184,
      "https://raw.githubusercontent.com/acme/example/abc123/preview.png",
      "image/webp",
      "webp",
    ],
    [592, source, "image/png,image/*;q=0.8", undefined],
  ] as const)(
    "transforms a registered screenshot at %s from %s for %s",
    async (width, screenshot, accept, format) => {
      const upstream = imageFetch(imageResponse("thumbnail"));
      const response = await handlePluginThumbnailRequest(
        thumbnailRequest(screenshot, width, plugin.id, accept),
        [{ ...plugin, media: [screenshot] }],
        upstream.fetchImage,
      );
      expect(upstream.calls).toEqual([
        {
          input: screenshot,
          init: {
            cf: { image: { width, fit: "scale-down", format, quality: 80 } },
          },
        },
      ]);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("thumbnail");
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(response.headers.get("vary")).toBe("Accept");
    },
  );

  it.each([
    ["Cloudflare error", () => new Response("error 9401", { status: 403 })],
    [
      "non-image success",
      () => new Response("<html>unavailable</html>", { headers: { "content-type": "text/html" } }),
    ],
    ["Cf-Resized error", () => imageResponse("error", { "cf-resized": "err=9401" })],
    ["network exception", () => new Error("Transform unavailable")],
  ] as const)("proxies the original with immutable caching on %s", async (_, failure) => {
    const upstream = imageFetch(failure(), imageResponse("original"));
    const response = await handlePluginThumbnailRequest(
      thumbnailRequest(),
      [plugin],
      upstream.fetchImage,
    );
    expect(upstream.calls.map((call) => call.input)).toEqual([source, source]);
    expect(upstream.calls[1].init).toBeUndefined();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("original");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it.each([
    ["arbitrary width", thumbnailRequest(source, 593), [plugin], 400],
    ["unlisted source on allowed host", thumbnailRequest(source + "?different"), [plugin], 404],
    ["wrong plugin ID", thumbnailRequest(source, 592, "acme/other"), [plugin], 404],
    [
      "missing plugin ID",
      new Request(`https://paseo.sh/plugins/thumb/592/${encodeURIComponent(source)}`),
      [plugin],
      404,
    ],
    ["removed plugin", thumbnailRequest(), [], 404],
    ["listed video", thumbnailRequest(video), [{ ...plugin, media: [video, source] }], 404],
    ["malformed encoding", new Request("https://paseo.sh/plugins/thumb/592/%ZZ"), [plugin], 400],
    ["malformed URL", thumbnailRequest("not a URL"), [plugin], 400],
    ...[
      "https://example.com/preview.png",
      "https://cdn.jsdelivr.net.evil.test/preview.png",
      "http://cdn.jsdelivr.net/preview.png",
      "https://user:pass@cdn.jsdelivr.net/preview.png",
      "https://cdn.jsdelivr.net:8080/preview.png",
    ].map(
      (url) =>
        [
          "disallowed registered source",
          thumbnailRequest(url),
          [{ ...plugin, media: [url] }],
          400,
        ] satisfies [string, Request, Plugin[], number],
    ),
  ] satisfies [string, Request, Plugin[], number][])(
    "rejects %s without fetching an image",
    async (_, request, plugins, status) => {
      const upstream = imageFetch();
      const response = await handlePluginThumbnailRequest(
        request,
        [...plugins],
        upstream.fetchImage,
      );
      expect(response.status).toBe(status);
      expect(upstream.calls).toEqual([]);
      expect(response.headers.get("cache-control")).toBeNull();
    },
  );

  it.each([
    () => new Response("missing", { status: 404 }),
    () => new Response("<html>error</html>", { headers: { "content-type": "text/html" } }),
    () => new Error("Origin unavailable"),
  ])("does not cache a failed original for a year", async (failure) => {
    const upstream = imageFetch(new Response("transform error", { status: 502 }), failure());
    const response = await handlePluginThumbnailRequest(
      thumbnailRequest(),
      [plugin],
      upstream.fetchImage,
    );
    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("round-trips screenshot URL punctuation through the card URL", async () => {
    const screenshot = source + "?name=a&other=b#preview";
    const upstream = imageFetch(imageResponse("thumbnail"));
    const request = new Request(
      "https://paseo.sh" + pluginCardScreenshot(plugin.id, screenshot).src,
    );
    const response = await handlePluginThumbnailRequest(
      request,
      [{ ...plugin, media: [screenshot] }],
      upstream.fetchImage,
    );
    expect(response.status).toBe(200);
    expect(upstream.calls[0].input).toBe(screenshot);
  });
});
