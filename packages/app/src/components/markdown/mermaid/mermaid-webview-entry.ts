import mermaid from "mermaid";

interface RenderMessage {
  type: "render";
  source: string;
  themeKey: string;
  themeVariables: Record<string, string | boolean>;
}

type InboundMessage = RenderMessage;

interface RenderedOutbound {
  type: "rendered";
  svg: string;
  height: number;
}

interface ErrorOutbound {
  type: "error";
  message: string;
}

type OutboundMessage = RenderedOutbound | ErrorOutbound;

let activeThemeKey: string | null = null;

function postMessage(message: OutboundMessage): void {
  const payload = JSON.stringify(message);
  const bridge = (
    window as Window & { ReactNativeWebView?: { postMessage: (data: string) => void } }
  ).ReactNativeWebView;
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- RN WebView bridge, not window.postMessage
  bridge?.postMessage(payload);
}

function applyTheme(themeKey: string, themeVariables: Record<string, string | boolean>): void {
  if (activeThemeKey === themeKey) {
    return;
  }
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    themeVariables,
  });
  activeThemeKey = themeKey;
}

async function renderDiagram(message: RenderMessage): Promise<void> {
  const trimmed = message.source.trim();
  if (trimmed.length === 0) {
    postMessage({ type: "error", message: "Empty diagram" });
    return;
  }

  try {
    applyTheme(message.themeKey, message.themeVariables);
    const renderId = `paseo-mermaid-${Math.random().toString(36).slice(2)}`;
    const { svg } = await mermaid.render(renderId, trimmed);

    const measureHost = document.createElement("div");
    measureHost.style.position = "fixed";
    measureHost.style.left = "-10000px";
    measureHost.style.top = "0";
    measureHost.style.width = `${document.documentElement.clientWidth || 320}px`;
    measureHost.innerHTML = svg;
    document.body.appendChild(measureHost);
    const svgElement = measureHost.querySelector("svg");
    if (svgElement) {
      svgElement.style.maxWidth = "100%";
      svgElement.style.height = "auto";
    }
    const height = Math.max(
      Math.ceil(measureHost.getBoundingClientRect().height),
      svgElement ? Math.ceil(svgElement.getBoundingClientRect().height) : 0,
      48,
    );
    measureHost.remove();

    const root = document.getElementById("root");
    if (root) {
      root.innerHTML = svg;
      const visibleSvg = root.querySelector("svg");
      if (visibleSvg) {
        visibleSvg.style.maxWidth = "100%";
        visibleSvg.style.height = "auto";
      }
    }

    postMessage({ type: "rendered", svg, height });
  } catch (error: unknown) {
    const messageText = error instanceof Error ? error.message : String(error);
    postMessage({ type: "error", message: messageText });
  }
}

function handleInbound(raw: string): void {
  let parsed: InboundMessage;
  try {
    parsed = JSON.parse(raw) as InboundMessage;
  } catch {
    return;
  }
  if (parsed.type !== "render") {
    return;
  }
  void renderDiagram(parsed);
}

(
  window as Window & { __paseoMermaidHandleMessage?: (raw: string) => void }
).__paseoMermaidHandleMessage = handleInbound;
