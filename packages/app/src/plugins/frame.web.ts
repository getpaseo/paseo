import {
  handlePluginGuestMessage,
  wrapPluginHtml,
  type PluginGuestHandlers,
  type PluginHostMessage,
} from "./bridge";

/**
 * `allow-same-origin` is deliberately absent: granting it would give the plugin
 * a real origin and therefore storage plus same-origin reach back into the app.
 * See docs/plugins.md "The sandbox".
 */
export const PLUGIN_IFRAME_SANDBOX = "allow-scripts";

/**
 * Built imperatively rather than in JSX so the sandbox attributes have exactly
 * one definition, and so a real-browser test can exercise the frame and the
 * bridge without mounting a component.
 */
export function createPluginIframe(html: string): HTMLIFrameElement {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", PLUGIN_IFRAME_SANDBOX);
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.setAttribute("title", "Paseo plugin");
  iframe.srcdoc = wrapPluginHtml(html);
  iframe.style.border = "none";
  iframe.style.width = "100%";
  iframe.style.height = "100%";
  iframe.style.display = "block";
  iframe.style.backgroundColor = "transparent";
  return iframe;
}

/**
 * Listen for messages from one specific frame. The `source` check is what stops
 * any other frame on the page from impersonating this plugin — a sandboxed
 * frame has an opaque origin, so `event.origin` is "null" and worthless here.
 */
export function attachPluginBridge(
  iframe: HTMLIFrameElement,
  handlers: PluginGuestHandlers,
): () => void {
  const listener = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow) {
      return;
    }
    handlePluginGuestMessage(event.data, handlers);
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}

export function postToPluginIframe(iframe: HTMLIFrameElement, message: PluginHostMessage): void {
  iframe.contentWindow?.postMessage(message, "*");
}
