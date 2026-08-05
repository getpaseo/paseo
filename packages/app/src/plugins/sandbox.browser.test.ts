import { afterEach, describe, expect, it } from "vitest";
import {
  PLUGIN_IFRAME_SANDBOX,
  attachPluginBridge,
  createPluginIframe,
  postToPluginIframe,
} from "./frame.web";
import {
  createInitMessage,
  createUpdateMessage,
  type PluginContext,
  type PluginThemeTokens,
} from "./bridge";

const THEME: PluginThemeTokens = {
  colorScheme: "dark",
  background: "#18181b",
  foreground: "#fafafa",
  foregroundMuted: "#a1a1aa",
  border: "#27272a",
  accent: "#20744A",
  fontFamily: "ui-sans-serif",
  monoFontFamily: "ui-monospace",
  fontSize: 14,
};

/**
 * A minimal real plugin: announces `ready`, echoes what the host sends back out
 * as an `open-file`, and reports a height. Everything the bridge contract
 * promises, exercised by a real script in a real sandboxed frame.
 */
const ECHO_PLUGIN_HTML = `<!doctype html>
<html>
  <head><title>echo</title></head>
  <body>
    <div id="mark">plugin rendered</div>
    <script>
      window.addEventListener("message", function (event) {
        var data = event.data;
        if (!data || data.paseo !== 1) return;
        if (data.type === "init") {
          window.parent.postMessage(
            { paseo: 1, type: "open-file", path: "init:" + data.context.path + ":" + data.theme.accent, lineStart: 7 },
            "*"
          );
          window.parent.postMessage({ paseo: 1, type: "resize", height: 321 }, "*");
        }
        if (data.type === "update") {
          window.parent.postMessage({ paseo: 1, type: "open-file", path: "update:" + data.context.path }, "*");
        }
      });
      window.parent.postMessage({ paseo: 1, type: "not-a-real-type" }, "*");
      window.parent.postMessage({ hello: "from a non-paseo message" }, "*");
      window.parent.postMessage({ paseo: 1, type: "ready" }, "*");
    </script>
  </body>
</html>`;

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

function mountEchoPlugin(context: PluginContext) {
  const events: string[] = [];
  const iframe = createPluginIframe(ECHO_PLUGIN_HTML);
  const detach = attachPluginBridge(iframe, {
    onReady: () => {
      events.push("ready");
      postToPluginIframe(iframe, createInitMessage(context, THEME));
    },
    onOpenFile: (input) => events.push(`open-file:${input.path}:${input.lineStart ?? "-"}`),
    onResize: (height) => events.push(`resize:${height}`),
  });
  document.body.appendChild(iframe);
  cleanups.push(() => {
    detach();
    iframe.remove();
  });
  return { events, iframe };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the plugin bridge");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("the web plugin sandbox", () => {
  it("renders plugin HTML in a frame that has no same-origin access", async () => {
    const { iframe } = mountEchoPlugin({
      kind: "file-preview",
      path: "/w/data.csv",
      content: "a,b",
    });

    expect(iframe.getAttribute("sandbox")).toBe(PLUGIN_IFRAME_SANDBOX);
    expect(iframe.sandbox.contains("allow-scripts")).toBe(true);
    for (const forbidden of [
      "allow-same-origin",
      "allow-popups",
      "allow-top-navigation",
      "allow-forms",
      "allow-modals",
    ]) {
      expect(iframe.sandbox.contains(forbidden)).toBe(false);
    }
    expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(iframe.srcdoc).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none';`,
    );
    expect(iframe.srcdoc).toContain("plugin rendered");

    // An opaque origin is the whole point: the host cannot reach into the frame,
    // and the frame cannot reach back out except through postMessage.
    await waitFor(() => iframe.contentWindow !== null);
    expect(() => {
      void iframe.contentWindow?.document.title;
    }).toThrow();
  });

  it("answers the plugin's ready with init and round-trips open-file and resize", async () => {
    const { events } = mountEchoPlugin({
      kind: "file-preview",
      path: "/w/data.csv",
      content: "a,b",
    });

    await waitFor(() => events.length >= 3);

    expect(events).toEqual(["ready", "open-file:init:/w/data.csv:#20744A:7", "resize:321"]);
  });

  it("delivers update when the context changes", async () => {
    const { events, iframe } = mountEchoPlugin({
      kind: "file-preview",
      path: "/w/data.csv",
      content: "a,b",
    });

    await waitFor(() => events.length >= 3);
    postToPluginIframe(
      iframe,
      createUpdateMessage({ kind: "file-preview", path: "/w/other.csv", content: "c,d" }),
    );
    await waitFor(() => events.length >= 4);

    expect(events[3]).toBe("open-file:update:/w/other.csv:-");
  });

  it("ignores messages from another frame on the page", async () => {
    const { events, iframe } = mountEchoPlugin({
      kind: "file-preview",
      path: "/w/data.csv",
      content: "a,b",
    });
    await waitFor(() => events.length >= 3);

    const impostor = createPluginIframe(
      `<!doctype html><html><body><script>
        window.parent.postMessage({ paseo: 1, type: "open-file", path: "/etc/passwd" }, "*");
      </script></body></html>`,
    );
    document.body.appendChild(impostor);
    cleanups.push(() => impostor.remove());

    // Give the impostor a real chance to be heard, then prove it was not.
    postToPluginIframe(
      iframe,
      createUpdateMessage({ kind: "file-preview", path: "/w/after.csv", content: "" }),
    );
    await waitFor(() => events.length >= 4);

    expect(events.some((event) => event.includes("/etc/passwd"))).toBe(false);
    expect(events[3]).toBe("open-file:update:/w/after.csv:-");
  });
});
