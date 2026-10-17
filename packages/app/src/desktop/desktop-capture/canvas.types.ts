export interface CaptureCanvasProps {
  png: string;
  mode: "rectangle" | "pen";
  disabled: boolean;
  onChange(images: string[]): void;
}
