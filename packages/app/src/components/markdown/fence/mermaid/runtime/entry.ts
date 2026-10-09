import mermaid from "mermaid";
import {
  parseMermaidRuntimeRenderMessage,
  type MermaidRuntimeMessage,
  type MermaidRuntimeRenderMessage,
} from "./messages";

declare global {
  interface Window {
    ReactNativeWebView?: {
      postMessage?: (data: string) => void;
    };
    __PASEO_MERMAID_RUNTIME_RECEIVE__?: (message: unknown) => void;
  }
}

function sendToHost(message: MermaidRuntimeMessage): void {
  window.ReactNativeWebView?.postMessage?.(JSON.stringify(message));
  if (window.parent !== window) {
    window.parent.postMessage(message, "*");
  }
}

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

let latestRevision = 0;
let pendingRender: MermaidRuntimeRenderMessage | null = null;
let isRendering = false;
let isDrainScheduled = false;

interface DiagramSize {
  height: number;
  width: number;
}

/**
 * Mermaid emits `width="100%"` with an inline `max-width` in pixels, so the diagram renders at
 * its natural width and never fills a larger box. The host sizes this frame, so let the diagram
 * follow the frame in both directions instead.
 */
function stretchToFrame(svg: SVGSVGElement): void {
  svg.style.maxWidth = "100%";
  svg.style.maxHeight = "100%";
  svg.style.width = "100%";
  svg.style.height = "100%";
}

/**
 * The reported size is the host's content size, and the host feeds it back as this frame's size.
 * Measuring the rendered box would make that a loop: every re-render lands in a frame the last
 * measurement shrank by the container's padding, so a streaming diagram ratchets down to nothing.
 * The viewBox is the diagram's own size and doesn't move.
 */
function measureDiagram(host: HTMLElement, svg: SVGSVGElement | null): DiagramSize {
  const viewBox = svg?.viewBox.baseVal;
  if (viewBox && viewBox.width > 0 && viewBox.height > 0) {
    return { height: Math.ceil(viewBox.height), width: Math.ceil(viewBox.width) };
  }
  const rect = svg?.getBoundingClientRect();
  return {
    height: Math.ceil(rect?.height ?? host.scrollHeight),
    width: Math.ceil(rect?.width ?? host.scrollWidth),
  };
}

async function render(message: MermaidRuntimeRenderMessage): Promise<void> {
  try {
    initializeMermaid(message.colorScheme);
    const { svg } = await mermaid.render(`paseo-mermaid-${message.revision}`, message.source);
    if (message.revision !== latestRevision) {
      return;
    }
    setViewport(message.interactive);
    const host = document.getElementById("diagram");
    if (!host) {
      return;
    }
    host.innerHTML = svg;
    const element = host.querySelector("svg");
    if (element) {
      stretchToFrame(element);
    }
    const size = measureDiagram(host, element);
    sendToHost({
      type: "rendered",
      revision: message.revision,
      source: message.source,
      colorScheme: message.colorScheme,
      height: size.height,
      width: size.width,
    });
  } catch {
    if (message.revision === latestRevision) {
      sendToHost({ type: "renderError", revision: message.revision });
    }
  }
}

async function drainRenderQueue(): Promise<void> {
  if (isRendering) {
    return;
  }
  isRendering = true;
  try {
    while (pendingRender) {
      const next = pendingRender;
      pendingRender = null;
      await render(next);
    }
  } finally {
    isRendering = false;
  }
}

function receiveRender(value: unknown): void {
  const message = parseMermaidRuntimeRenderMessage(value);
  if (!message) {
    return;
  }
  latestRevision = message.revision;
  pendingRender = message;
  if (isRendering || isDrainScheduled) {
    return;
  }
  isDrainScheduled = true;
  window.setTimeout(() => {
    isDrainScheduled = false;
    void drainRenderQueue();
  }, 0);
}

window.__PASEO_MERMAID_RUNTIME_RECEIVE__ = receiveRender;
window.addEventListener("message", (event) => {
  if (event.source === window.parent) {
    receiveRender(event.data);
  }
});

sendToHost({ type: "bridgeReady" });
