import { useEffect, useRef } from "react";
import { captureSelection } from "./selection";
import type { CaptureCanvasProps } from "./canvas.types";

export function CaptureCanvas({ png, mode, disabled, onChange }: CaptureCanvasProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const change = useRef(onChange);
  change.current = onChange;
  const current = useRef({ mode, disabled });
  current.current = { mode, disabled };
  useEffect(() => {
    const canvas = ref.current!;
    const context = canvas.getContext("2d")!;
    const image = new Image();
    let previous: ImageData | null = null;
    let start: { x: number; y: number } | null = null;
    let crop: ReturnType<typeof captureSelection> = null;
    function exportImages() {
      const images = [canvas.toDataURL("image/png")];
      if (crop) {
        const region = document.createElement("canvas");
        region.width = crop.width;
        region.height = crop.height;
        region
          .getContext("2d")!
          .drawImage(
            canvas,
            crop.x,
            crop.y,
            crop.width,
            crop.height,
            0,
            0,
            crop.width,
            crop.height,
          );
        images.push(region.toDataURL("image/png"));
      }
      change.current(images);
    }
    const loaded = () => {
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      context.drawImage(image, 0, 0);
      exportImages();
    };
    image.addEventListener("load", loaded);
    image.src = `data:image/png;base64,${png}`;
    function point(event: PointerEvent) {
      const box = canvas.getBoundingClientRect();
      return {
        x: ((event.clientX - box.left) * canvas.width) / box.width,
        y: ((event.clientY - box.top) * canvas.height) / box.height,
      };
    }
    function down(event: PointerEvent) {
      if (current.current.disabled || !image.complete) return;
      canvas.setPointerCapture(event.pointerId);
      start = point(event);
      previous = context.getImageData(0, 0, canvas.width, canvas.height);
      context.lineWidth = Math.max(3, canvas.width / 450);
      context.strokeStyle = "rgb(255 72 52)";
      context.lineCap = "round";
      context.beginPath();
      context.moveTo(start.x, start.y);
    }
    function move(event: PointerEvent) {
      if (!start || current.current.disabled) return;
      const end = point(event);
      if (current.current.mode === "pen") {
        context.lineTo(end.x, end.y);
        context.stroke();
      } else {
        context.putImageData(previous!, 0, 0);
        crop = captureSelection(start, end, { width: canvas.width, height: canvas.height });
        if (crop) context.strokeRect(crop.x, crop.y, crop.width, crop.height);
      }
    }
    function up(event: PointerEvent) {
      if (!start) return;
      move(event);
      start = null;
      previous = null;
      exportImages();
    }
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    return () => {
      image.removeEventListener("load", loaded);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
    };
  }, [png]);
  return (
    <canvas
      ref={ref}
      aria-label="Entourez une zone"
      style={disabled ? disabledCanvasStyle : canvasStyle}
    />
  );
}

const canvasStyle = {
  display: "block",
  width: "100%",
  touchAction: "none",
  cursor: "crosshair",
} as const;
const disabledCanvasStyle = { ...canvasStyle, cursor: "default" } as const;
