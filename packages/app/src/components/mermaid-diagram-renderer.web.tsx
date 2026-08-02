import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import type { CSSProperties } from "react";
import {
  createMermaidDomCamera,
  type MermaidCameraState,
  type MermaidDomCamera,
} from "./mermaid-diagram-dom-camera";
import type { MermaidDiagramPalette } from "./mermaid-diagram-render";

export interface MermaidDiagramRendererHandle {
  fit: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
}

export interface MermaidDiagramRendererProps {
  code: string;
  palette: MermaidDiagramPalette;
  onCameraStateChange: (state: MermaidCameraState) => void;
  onError: () => void;
  onRendered: () => void;
}

let nextDiagramId = 1;
const VIEWPORT_STYLE: CSSProperties = {
  width: "100%",
  height: "100%",
  overflow: "hidden",
  position: "relative",
};
const CANVAS_STYLE: CSSProperties = {
  position: "absolute",
  left: 0,
  top: 0,
  transformOrigin: "0 0",
};

export const MermaidDiagramRenderer = forwardRef<
  MermaidDiagramRendererHandle,
  MermaidDiagramRendererProps
>(function MermaidDiagramRenderer(
  { code, palette, onCameraStateChange, onError, onRendered },
  ref,
) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<MermaidDomCamera>(null);
  const diagramIdRef = useRef(`paseo-mermaid-${nextDiagramId++}`);

  useImperativeHandle(
    ref,
    () => ({
      fit: () => cameraRef.current?.fit(),
      zoomIn: () => cameraRef.current?.zoomIn(),
      zoomOut: () => cameraRef.current?.zoomOut(),
    }),
    [],
  );

  const fitCamera = useCallback(() => cameraRef.current?.fit(), []);

  useEffect(() => {
    const viewport = viewportRef.current;
    const canvas = canvasRef.current;
    if (!viewport || !canvas) {
      return;
    }

    const camera = createMermaidDomCamera({ viewport, canvas, onStateChange: onCameraStateChange });
    cameraRef.current = camera;
    const observer = new ResizeObserver(fitCamera);
    observer.observe(viewport);
    return () => {
      observer.disconnect();
      camera.destroy();
      cameraRef.current = null;
    };
  }, [fitCamera, onCameraStateChange]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const renderHost = canvas;
    let cancelled = false;
    renderHost.replaceChildren();
    async function renderDiagram() {
      try {
        const { renderMermaidDiagram } = await import("./mermaid-diagram-render");
        const size = await renderMermaidDiagram(diagramIdRef.current, code, palette, renderHost);
        if (cancelled) {
          return;
        }
        cameraRef.current?.setContentSize(size.width, size.height);
        onRendered();
      } catch {
        if (!cancelled) {
          onError();
        }
      }
    }
    void renderDiagram();
    return () => {
      cancelled = true;
    };
  }, [code, onError, onRendered, palette]);

  return (
    <div ref={viewportRef} data-testid="mermaid-diagram-viewport" style={VIEWPORT_STYLE}>
      <div ref={canvasRef} style={CANVAS_STYLE} />
    </div>
  );
});
