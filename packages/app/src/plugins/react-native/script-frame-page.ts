// The page a ScriptFrame runs a plugin's script in, and the messages between it and the app.
// Native and web build the same page; only how a message crosses differs. Nothing here touches
// the DOM: the app's unit tests load it in Node.

export const SCRIPT_FRAME_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; form-action 'none'";

export type FrameTransport = "native" | "web";

/** What the page tells the app. A plugin's own text rides inside `message`. */
export type PageMessage =
  | { paseoFrame: "ready" }
  | { paseoFrame: "message"; text: string }
  | { paseoFrame: "error"; message: string };

export function parsePageMessage(value: unknown): PageMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const { paseoFrame, text, message } = value as Record<string, unknown>;
  if (paseoFrame === "ready") return { paseoFrame };
  if (paseoFrame === "message" && typeof text === "string") return { paseoFrame, text };
  if (paseoFrame === "error" && typeof message === "string") return { paseoFrame, message };
  return null;
}

const SEND: Record<FrameTransport, string> = {
  native: "window.ReactNativeWebView.postMessage(JSON.stringify(message))",
  web: 'window.parent.postMessage(message, "*")',
};

// On the web the app's text arrives by `message` events from the parent; on native the app calls
// `paseoFrame.onMessage` itself (see deliverScript).
const RECEIVE_WEB = `
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (event.source !== window.parent || !data || data.paseoFrame !== "call") return;
    if (typeof frame.onMessage === "function") frame.onMessage(String(data.text));
  });`;

/** Defines `window.paseoFrame` and the error reports. Runs before the plugin's script. */
export function bootstrapSource(transport: FrameTransport): string {
  return `(function () {
  var send = function (message) { ${SEND[transport]}; };
  var frame = {
    onMessage: null,
    post: function (text) { send({ paseoFrame: "message", text: String(text) }); }
  };
  window.paseoFrame = frame;${transport === "web" ? RECEIVE_WEB : ""}
  window.addEventListener("error", function (event) {
    send({ paseoFrame: "error", message: String(event.message || "The script failed") });
  });
  window.addEventListener("unhandledrejection", function (event) {
    var reason = event.reason;
    send({ paseoFrame: "error", message: String((reason && reason.message) || reason) });
  });
  Object.defineProperty(window, "__paseoFrameReady", {
    configurable: true,
    value: function () { send({ paseoFrame: "ready" }); }
  });
})();`;
}

/** A script's text must not end its own tag, or open an HTML comment. */
function escapeScript(source: string): string {
  return source.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
}

/** Standards mode, the policy before any script, then the bootstrap, the plugin's script, ready. */
export function scriptFrameHtml(script: string, transport: FrameTransport): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${SCRIPT_FRAME_CSP}">` +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    "</head><body>" +
    `<script>${bootstrapSource(transport)}</script>` +
    `<script>${escapeScript(script)}</script>` +
    "<script>if (window.__paseoFrameReady) { window.__paseoFrameReady(); delete window.__paseoFrameReady; }</script>" +
    "</body></html>"
  );
}

/** The call a native frame injects to hand `text` to the page. */
export function deliverScript(text: string): string {
  return `(function () { var f = window.paseoFrame && window.paseoFrame.onMessage; if (typeof f === "function") f(${JSON.stringify(text)}); })(); true;`;
}

export interface PostQueue {
  post(text: string): void;
  ready(): void;
  reset(): void;
}

/** Posts wait until the page says it is ready, then go out in the order they were made. */
export function createPostQueue(deliver: (text: string) => void): PostQueue {
  let open = false;
  let waiting: string[] = [];
  return {
    post(text) {
      if (open) deliver(text);
      else waiting.push(text);
    },
    ready() {
      if (open) return;
      open = true;
      const out = waiting;
      waiting = [];
      for (const text of out) deliver(text);
    },
    reset() {
      open = false;
    },
  };
}

export function routePageMessage(
  message: PageMessage,
  queue: PostQueue,
  handlers: { onMessage(text: string): void; onError?(message: string): void },
): void {
  if (message.paseoFrame === "ready") queue.ready();
  else if (message.paseoFrame === "message") handlers.onMessage(message.text);
  else handlers.onError?.(message.message);
}
