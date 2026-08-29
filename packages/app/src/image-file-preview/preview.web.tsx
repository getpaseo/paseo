import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type SyntheticEvent,
} from "react";
import { ImageFilePreviewControls } from "./controls";
import {
  FIT_IMAGE_TRANSFORM,
  IMAGE_ZOOM_STEP,
  type ImagePreviewPoint,
  type ImagePreviewSize,
  type ImagePreviewTransform,
  fitImageSize,
  panImage,
  zoomImageAtPoint,
} from "./transform";

interface ImageFilePreviewProps {
  uri: string;
}

interface PointerDrag {
  pointerId: number;
  startPoint: ImagePreviewPoint;
  startTransform: ImagePreviewTransform;
}

const rootStyle: CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  minHeight: 0,
  overflow: "hidden",
};

const canvasStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  overflow: "hidden",
  touchAction: "none",
};

const imageStyle: CSSProperties = {
  display: "block",
  maxWidth: "none",
  maxHeight: "none",
  userSelect: "none",
  pointerEvents: "none",
  transformOrigin: "center center",
};

export function ImageFilePreview({ uri }: ImageFilePreviewProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const transformRef = useRef<ImagePreviewTransform>(FIT_IMAGE_TRANSFORM);
  const dragRef = useRef<PointerDrag | null>(null);
  const [viewport, setViewport] = useState<ImagePreviewSize | null>(null);
  const [imageSize, setImageSize] = useState<ImagePreviewSize | null>(null);
  const [transform, setTransform] = useState<ImagePreviewTransform>(FIT_IMAGE_TRANSFORM);
  const [isDragging, setIsDragging] = useState(false);

  const fittedImage = useMemo(
    () => (imageSize && viewport ? fitImageSize(imageSize, viewport) : null),
    [imageSize, viewport],
  );

  const commitTransform = useCallback((nextTransform: ImagePreviewTransform) => {
    transformRef.current = nextTransform;
    setTransform(nextTransform);
  }, []);

  const reset = useCallback(() => {
    commitTransform(FIT_IMAGE_TRANSFORM);
  }, [commitTransform]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setViewport({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setImageSize(null);
    reset();
  }, [reset, uri]);

  useEffect(() => {
    reset();
  }, [reset, viewport?.height, viewport?.width]);

  const zoomAt = useCallback(
    (zoom: number, focalPoint: ImagePreviewPoint) => {
      if (!fittedImage || !viewport) return;
      commitTransform(
        zoomImageAtPoint({
          transform: transformRef.current,
          zoom,
          focalPoint,
          fittedImage,
          viewport,
        }),
      );
    },
    [commitTransform, fittedImage, viewport],
  );

  const zoomFromCenter = useCallback(
    (delta: number) => {
      if (!viewport) return;
      zoomAt(transformRef.current.zoom + delta, {
        x: viewport.width / 2,
        y: viewport.height / 2,
      });
    },
    [viewport, zoomAt],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    function onWheel(event: WheelEvent) {
      event.preventDefault();
      const bounds = canvas?.getBoundingClientRect();
      if (!bounds) return;
      const zoomFactor = Math.exp(-event.deltaY * 0.002);
      zoomAt(transformRef.current.zoom * zoomFactor, {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      });
    }

    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const startDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (transformRef.current.zoom <= 1) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startPoint: { x: event.clientX, y: event.clientY },
      startTransform: transformRef.current,
    };
    setIsDragging(true);
  }, []);

  const continueDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId || !fittedImage || !viewport) return;
      commitTransform(
        panImage({
          transform: drag.startTransform,
          delta: {
            x: event.clientX - drag.startPoint.x,
            y: event.clientY - drag.startPoint.y,
          },
          fittedImage,
          viewport,
        }),
      );
    },
    [commitTransform, fittedImage, viewport],
  );

  const endDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setIsDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const renderedCanvasStyle = useMemo<CSSProperties>(() => {
    let cursor: CSSProperties["cursor"] = "default";
    if (transform.zoom > 1) cursor = isDragging ? "grabbing" : "grab";
    return { ...canvasStyle, cursor };
  }, [isDragging, transform.zoom]);

  const renderedImageStyle = useMemo<CSSProperties>(() => {
    return {
      ...imageStyle,
      width: fittedImage?.width ?? 0,
      height: fittedImage?.height ?? 0,
      transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.zoom})`,
    };
  }, [fittedImage, transform]);

  const imageLoaded = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
    setImageSize({
      width: event.currentTarget.naturalWidth,
      height: event.currentTarget.naturalHeight,
    });
  }, []);

  const zoomIn = useCallback(() => {
    zoomFromCenter(IMAGE_ZOOM_STEP);
  }, [zoomFromCenter]);

  const zoomOut = useCallback(() => {
    zoomFromCenter(-IMAGE_ZOOM_STEP);
  }, [zoomFromCenter]);

  return (
    <div data-testid="image-file-preview" style={rootStyle}>
      <div
        data-testid="image-file-preview-canvas"
        onPointerCancel={endDrag}
        onPointerDown={startDrag}
        onPointerMove={continueDrag}
        onPointerUp={endDrag}
        ref={canvasRef}
        style={renderedCanvasStyle}
      >
        <img alt="" draggable={false} onLoad={imageLoaded} src={uri} style={renderedImageStyle} />
      </div>
      <ImageFilePreviewControls
        zoom={transform.zoom}
        onReset={reset}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
      />
    </div>
  );
}
