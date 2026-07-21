import mermaid from "mermaid";

interface RenderMessage {
  type: "render";
  requestId: number;
  code: string;
  colorScheme: "light" | "dark";
  interactive: boolean;
}

type InboundMessage = RenderMessage;

type OutboundMessage =
  | { type: "bridgeReady" }
  | { type: "rendered"; requestId: number; height: number; width: number }
  | { type: "renderError"; requestId: number };

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
// initialize()/render() mutate shared global mermaid state; serialize renders
// so a newer message can't re-initialize (e.g. flip the theme) while a prior
// layout is still running. Superseded queued renders are skipped entirely.
let renderChain: Promise<void> = Promise.resolve();

async function render(message: RenderMessage, seq: number): Promise<void> {
  if (seq !== renderSeq) return;
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
      requestId: message.requestId,
      height: Math.ceil(rect?.height ?? host.scrollHeight),
      width: Math.ceil(rect?.width ?? 0),
    });
  } catch {
    // Invalid or still-streaming diagram source — keep the previous render.
    if (seq === renderSeq) sendToNative({ type: "renderError", requestId: message.requestId });
  }
}

window.__PASEO_MERMAID_WEBVIEW_RECEIVE__ = (message) => {
  if (message?.type !== "render") return;
  renderSeq += 1;
  const seq = renderSeq;
  renderChain = renderChain.then(() => render(message, seq));
};

sendToNative({ type: "bridgeReady" });
