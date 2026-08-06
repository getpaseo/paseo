import { afterEach, describe, expect, it } from "vitest";
import { wrapPluginHostDocument } from "./bridge";

/**
 * The native path, in a real browser. `sandbox.tsx` is a WebView and cannot run
 * here, but everything that decides whether a plugin renders on a phone is in
 * the host document it loads: the relay that carries `ready` out to
 * `ReactNativeWebView` and `init` back down to the plugin frame.
 *
 * Nothing else covers it. A broken relay is a blank pane and a ten-second
 * timeout on every device, and the unit tests around `wrapPluginHostDocument`
 * only match strings.
 */
const PLUGIN_HTML = `<!doctype html>
<html>
  <body>
    <script>
      window.addEventListener("message", function (event) {
        var data = event.data;
        if (!data || data.paseo !== 1) return;
        parent.parent.postMessage(
          { probe: 1, type: "received", received: data.type, fromParent: event.source === parent },
          "*",
        );
      });
      parent.postMessage({ paseo: 1, type: "ready" }, "*");
    </script>
  </body>
</html>`;

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(read: () => T | null, what: string): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = read();
    if (value !== null) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await sleep(10);
  }
}

interface MountedHost {
  frame: HTMLIFrameElement;
  bridged: string[];
  received: Array<{ received: string; fromParent: boolean }>;
}

/**
 * The host document is ours, so it is mounted unsandboxed and same-origin —
 * that is what lets the test stub `ReactNativeWebView` the way the WebView
 * does. The plugin frame inside it is still `sandbox="allow-scripts"`, which is
 * the boundary under test.
 */
async function mountHost(html: string): Promise<MountedHost> {
  const bridged: string[] = [];
  const received: Array<{ received: string; fromParent: boolean }> = [];
  const onMessage = (event: MessageEvent) => {
    const data = event.data as { probe?: number; received?: string; fromParent?: boolean };
    if (data?.probe === 1 && data.received) {
      received.push({ received: data.received, fromParent: data.fromParent === true });
    }
  };
  window.addEventListener("message", onMessage);

  const frame = document.createElement("iframe");
  frame.srcdoc = wrapPluginHostDocument(html);
  document.body.appendChild(frame);
  cleanups.push(() => {
    window.removeEventListener("message", onMessage);
    frame.remove();
  });

  const hosted = await waitFor(() => frame.contentWindow, "the host document");
  (
    hosted as unknown as { ReactNativeWebView: { postMessage(value: string): void } }
  ).ReactNativeWebView = {
    postMessage: (value: string) => bridged.push(value),
  };

  return { frame, bridged, received };
}

describe("the native host document", () => {
  it("carries ready out to the bridge and init back down to the plugin", async () => {
    const host = await mountHost(PLUGIN_HTML);

    await waitFor(() => (host.bridged.length > 0 ? host.bridged : null), "the plugin's ready");
    expect(JSON.parse(host.bridged[0] ?? "null")).toEqual({ paseo: 1, type: "ready" });

    const post = (host.frame.contentWindow as unknown as { __paseoPost(message: unknown): void })
      .__paseoPost;
    expect(typeof post).toBe("function");
    post({ paseo: 1, type: "init", context: { kind: "sidebar-panel" }, theme: {} });

    const arrived = await waitFor(
      () => (host.received.length > 0 ? host.received : null),
      "init to reach the plugin",
    );
    expect(arrived[0]).toEqual({ received: "init", fromParent: true });
  });

  it("does not relay a message from anything but the plugin frame", async () => {
    const host = await mountHost("<p>quiet</p>");
    await sleep(200);

    host.frame.contentWindow?.postMessage({ paseo: 1, type: "open-file", path: "a.ts" }, "*");
    await sleep(200);

    // Posted by the test window, not the plugin frame. Forwarding it would let
    // any frame on the page drive the app through the plugin's channel.
    expect(host.bridged).toEqual([]);
  });

  // A srcdoc frame inherits its parent's CSP, so the guest's effective policy is
  // the intersection of the two. A host policy hand-written to be "just what the
  // host needs" silently subtracts from the plugin's — one earlier copy dropped
  // `img-src`, and every data-URL image died on native and nowhere else.
  it("does not narrow the plugin's policy by inheritance", async () => {
    const host = await mountHost(`<script>
      var img = new Image();
      img.onload = function () { parent.parent.postMessage({ probe: 1, received: "loaded" }, "*"); };
      img.onerror = function () { parent.parent.postMessage({ probe: 1, received: "blocked" }, "*"); };
      img.src = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
    </script>`);

    const outcome = await waitFor(
      () => (host.received.length > 0 ? host.received : null),
      "the image to settle",
    );
    expect(outcome[0]?.received).toBe("loaded");
  });

  it("does not echo host messages back to the bridge", async () => {
    const host = await mountHost(
      `<script>parent.postMessage({ paseo: 1, type: "init" }, "*");</script>`,
    );
    await sleep(300);

    expect(host.bridged).toEqual([]);
  });
});
