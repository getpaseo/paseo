import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyWebBaseUrlToIndexHtml,
  applyWebBaseUrlToManifest,
  normalizeWebBaseUrl,
} from "./web-base-url.mjs";

test("normalizes the base URL", () => {
  assert.equal(normalizeWebBaseUrl(undefined), "");
  assert.equal(normalizeWebBaseUrl("/"), "");
  assert.equal(normalizeWebBaseUrl("/user/alice/paseo/"), "/user/alice/paseo");
  assert.throws(() => normalizeWebBaseUrl("paseo"), /Invalid PASEO_WEB_BASE_URL/);
  assert.throws(() => normalizeWebBaseUrl("/a/../b"), /Invalid PASEO_WEB_BASE_URL/);
});

test("prefixes the hand-written public links in index.html", () => {
  const html =
    '<link rel="manifest" href="/manifest.json" />\n' +
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />\n' +
    '<link rel="icon" href="/paseo/favicon.ico"/>';
  assert.equal(
    applyWebBaseUrlToIndexHtml(html, "/paseo"),
    '<link rel="manifest" href="/paseo/manifest.json" />\n' +
      '<link rel="apple-touch-icon" href="/paseo/apple-touch-icon.png" />\n' +
      '<link rel="icon" href="/paseo/favicon.ico"/>',
  );
});

test("leaves index.html and the manifest unchanged without a base URL", () => {
  const html = '<link rel="manifest" href="/manifest.json" />';
  assert.equal(applyWebBaseUrlToIndexHtml(html, ""), html);
  const manifest = { start_url: "/" };
  assert.equal(applyWebBaseUrlToManifest(manifest, ""), manifest);
});

test("prefixes manifest scope, start URL, id and icons", () => {
  const manifest = {
    id: "/",
    start_url: "/",
    scope: "/",
    name: "Paseo",
    icons: [{ src: "/pwa-icon-192.png", sizes: "192x192" }],
  };
  assert.deepEqual(applyWebBaseUrlToManifest(manifest, "/paseo"), {
    id: "/paseo/",
    start_url: "/paseo/",
    scope: "/paseo/",
    name: "Paseo",
    icons: [{ src: "/paseo/pwa-icon-192.png", sizes: "192x192" }],
  });
});
