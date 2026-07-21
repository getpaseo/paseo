import mermaid from "mermaid";

interface RenderMessage {
  type: "render";
  code: string;
  colorScheme: "light" | "dark";
  interactive: boolean;
}

type InboundMessage = RenderMessage;

type OutboundMessage =
  | { type: "bridgeReady" }
  | { type: "rendered"; height: number; width: number }
  | { type: "renderError" };

declare global {
  interface Window {
    ReactNativeWebView?: {
      postMessage?: (data: string) => void;
    };
    __PASEO_MERMAID_WEBVIEW_RECEIVE__?: (message: InboundMessage) => void;
  }
}

function sendToNative(message: OutboundMessage): void {
  window.ReactNativeWebView?.postMessage?.(JSON.stringify(message));
}

// Same hardening as mermaid-diagram.web.tsx: strict sanitization, no HTML
// labels entering the live DOM, and directives locked out of app-owned theme
// keys. The RN side additionally rejects resource-bearing source
// (containsUnsafeMermaidSource) before it ever reaches this webview.
function initializeMermaid(colorScheme: "light" | "dark"): void {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    theme: colorScheme === "dark" ? "dark" : "default",
    secure: [
      "secure",
      "securityLevel",
      "startOnLoad",
      "maxTextSize",
      "suppressErrorRendering",
      "maxEdges",
      "theme",
      "themeVariables",
      "themeCSS",
    ],
    flowchart: { htmlLabels: false },
    class: { htmlLabels: false },
  });
}

function setViewport(interactive: boolean): void {
  document
    .querySelector('meta[name="viewport"]')
    ?.setAttribute(
      "content",
      interactive
        ? "width=device-width, initial-scale=1, maximum-scale=8"
        : "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no",
    );
}

let renderSeq = 0;

async function render(message: RenderMessage): Promise<void> {
  renderSeq += 1;
  const seq = renderSeq;
  initializeMermaid(message.colorScheme);
  try {
    const { svg } = await mermaid.render(`paseo-mermaid-native-${seq}`, message.code);
    if (seq !== renderSeq) return;
    setViewport(message.interactive);
    const host = document.getElementById("diagram");
    if (!host) return;
    host.innerHTML = svg;
    const rect = host.querySelector("svg")?.getBoundingClientRect();
    sendToNative({
      type: "rendered",
      height: Math.ceil(rect?.height ?? host.scrollHeight),
      width: Math.ceil(rect?.width ?? 0),
    });
  } catch {
    // Invalid or still-streaming diagram source — keep the previous render.
    if (seq === renderSeq) sendToNative({ type: "renderError" });
  }
}

window.__PASEO_MERMAID_WEBVIEW_RECEIVE__ = (message) => {
  if (message?.type === "render") void render(message);
};

sendToNative({ type: "bridgeReady" });
