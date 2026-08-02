import {
  createMermaidDomCamera,
  type MermaidDomCamera,
  type MermaidPanBehavior,
} from "@/components/mermaid-diagram-dom-camera";
import {
  renderMermaidDiagram,
  type MermaidDiagramPalette,
} from "@/components/mermaid-diagram-render";

interface RenderMessage {
  type: "render";
  code: string;
  palette: MermaidDiagramPalette;
  panBehavior: MermaidPanBehavior;
}

interface CommandMessage {
  type: "fit" | "zoomIn" | "zoomOut";
}

type InboundMessage = RenderMessage | CommandMessage;

declare global {
  interface Window {
    ReactNativeWebView?: {
      postMessage?: (message: string) => void;
    };
    __PASEO_MERMAID_RECEIVE__?: (message: string) => void;
  }
}

function send(message: object): void {
  window.ReactNativeWebView?.postMessage?.(JSON.stringify(message));
}

function stringProperty(value: object, key: string): string {
  const property = Reflect.get(value, key);
  if (typeof property !== "string") {
    throw new Error(`Invalid ${key}`);
  }
  return property;
}

function parsePalette(value: unknown): MermaidDiagramPalette {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid palette");
  }
  return {
    background: stringProperty(value, "background"),
    border: stringProperty(value, "border"),
    foreground: stringProperty(value, "foreground"),
    mutedForeground: stringProperty(value, "mutedForeground"),
    primary: stringProperty(value, "primary"),
    primaryForeground: stringProperty(value, "primaryForeground"),
    surface: stringProperty(value, "surface"),
  };
}

function parseMessage(serialized: string): InboundMessage {
  const value: unknown = JSON.parse(serialized);
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid Mermaid message");
  }

  const type = Reflect.get(value, "type");
  if (type === "fit" || type === "zoomIn" || type === "zoomOut") {
    return { type };
  }
  if (type === "render") {
    const panBehavior = stringProperty(value, "panBehavior");
    if (panBehavior !== "clamped" && panBehavior !== "rubber-band") {
      throw new Error("Invalid pan behavior");
    }
    return {
      type,
      code: stringProperty(value, "code"),
      palette: parsePalette(Reflect.get(value, "palette")),
      panBehavior,
    };
  }
  throw new Error("Unknown Mermaid message");
}

const root = document.createElement("div");
root.id = "mermaid-viewport";
const canvas = document.createElement("div");
canvas.id = "mermaid-canvas";
root.appendChild(canvas);
document.body.appendChild(root);

let camera: MermaidDomCamera | null = createMermaidDomCamera({
  viewport: root,
  canvas,
  onStateChange: (state) => send({ type: "camera", ...state }),
});
let renderEpoch = 0;

async function render(message: RenderMessage): Promise<void> {
  const epoch = ++renderEpoch;
  camera?.setPanBehavior(message.panBehavior);
  canvas.replaceChildren();
  try {
    const size = await renderMermaidDiagram(
      `paseo-mermaid-native-${epoch}`,
      message.code,
      message.palette,
      canvas,
    );
    if (epoch !== renderEpoch) {
      return;
    }
    camera?.setContentSize(size.width, size.height);
    send({ type: "rendered" });
  } catch {
    if (epoch === renderEpoch) {
      send({ type: "error" });
    }
  }
}

window.__PASEO_MERMAID_RECEIVE__ = (serialized) => {
  try {
    const message = parseMessage(serialized);
    if (message.type === "render") {
      void render(message);
    } else if (message.type === "fit") {
      camera?.fit();
    } else if (message.type === "zoomIn") {
      camera?.zoomIn();
    } else {
      camera?.zoomOut();
    }
  } catch {
    send({ type: "error" });
  }
};

window.addEventListener("beforeunload", () => {
  camera?.destroy();
  camera = null;
});

send({ type: "ready" });
