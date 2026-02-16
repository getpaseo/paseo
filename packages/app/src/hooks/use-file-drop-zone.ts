import { useState, useRef, useEffect } from "react";
import { Platform } from "react-native";
import type { ImageAttachment } from "@/components/message-input";

interface UseFileDropZoneOptions {
  onFilesDropped: (files: ImageAttachment[]) => void;
  disabled?: boolean;
}

interface UseFileDropZoneReturn {
  isDragging: boolean;
  containerRef: React.RefObject<HTMLElement | null>;
}

const IS_WEB = Platform.OS === "web";
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".avif": "image/avif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

type TauriDragDropPayload =
  | {
      type: "enter";
      paths: string[];
    }
  | {
      type: "over";
    }
  | {
      type: "drop";
      paths: string[];
    }
  | {
      type: "leave";
    };

type TauriDragDropEvent = {
  payload: TauriDragDropPayload;
};

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

function isTauriEnvironment(): boolean {
  return typeof window !== "undefined" && (window as any).__TAURI__ !== undefined;
}

function getFileExtension(path: string): string {
  const normalizedPath = path.split("#", 1)[0]?.split("?", 1)[0] ?? path;
  const extensionIndex = normalizedPath.lastIndexOf(".");
  if (extensionIndex < 0) {
    return "";
  }
  return normalizedPath.slice(extensionIndex).toLowerCase();
}

function isImagePath(path: string): boolean {
  return getFileExtension(path) in IMAGE_MIME_BY_EXTENSION;
}

function filePathToImageAttachment(path: string): ImageAttachment {
  const extension = getFileExtension(path);
  const mimeType = IMAGE_MIME_BY_EXTENSION[extension] ?? "image/jpeg";
  const convertFileSrc = (window as any).__TAURI__?.core?.convertFileSrc;
  const uri =
    typeof convertFileSrc === "function" ? convertFileSrc(path) : path;

  return {
    uri,
    mimeType,
  };
}

async function fileToImageAttachment(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve({
          uri: reader.result,
          mimeType: file.type || "image/jpeg",
        });
      } else {
        reject(new Error("Failed to read file as data URL"));
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function useFileDropZone({
  onFilesDropped,
  disabled = false,
}: UseFileDropZoneOptions): UseFileDropZoneReturn {
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLElement | null>(null);
  const dragCounterRef = useRef(0);
  const onFilesDroppedRef = useRef(onFilesDropped);

  // Keep callback ref up to date
  useEffect(() => {
    onFilesDroppedRef.current = onFilesDropped;
  }, [onFilesDropped]);

  // Reset drag state when disabled changes
  useEffect(() => {
    if (disabled) {
      setIsDragging(false);
      dragCounterRef.current = 0;
    }
  }, [disabled]);

  // Set up event listeners on web
  useEffect(() => {
    if (!IS_WEB) return;

    let disposed = false;
    let cleanup: (() => void) | undefined;

    async function setupTauriDragDrop(): Promise<boolean> {
      if (!isTauriEnvironment()) {
        return false;
      }

      const tauriWindow = (window as any).__TAURI__?.window?.getCurrentWindow?.();
      if (!tauriWindow || typeof tauriWindow.onDragDropEvent !== "function") {
        return false;
      }

      try {
        const unlisten = await tauriWindow.onDragDropEvent(
          (event: TauriDragDropEvent) => {
            const payload = event.payload;
            if (payload.type === "leave") {
              setIsDragging(false);
              return;
            }

            if (payload.type === "enter" || payload.type === "over") {
              if (!disabled) {
                setIsDragging(true);
              }
              return;
            }

            // Drop always ends the current drag operation.
            setIsDragging(false);

            if (disabled) return;

            const imagePaths = payload.paths.filter(isImagePath);
            if (imagePaths.length === 0) {
              return;
            }

            const attachments = imagePaths.map(filePathToImageAttachment);
            onFilesDroppedRef.current(attachments);
          }
        );

        if (disposed) {
          unlisten();
          return true;
        }

        cleanup = unlisten;
        return true;
      } catch (error) {
        console.warn("[useFileDropZone] Failed to listen for Tauri drag-drop:", error);
        return false;
      }
    }

    function setupDomDragDrop() {
      const element = containerRef.current;
      if (!element) {
        return;
      }

      function handleDragEnter(e: DragEvent) {
        e.preventDefault();
        e.stopPropagation();

        if (disabled) return;

        dragCounterRef.current++;
        if (e.dataTransfer?.types.includes("Files")) {
          setIsDragging(true);
        }
      }

      function handleDragOver(e: DragEvent) {
        e.preventDefault();
        e.stopPropagation();

        if (disabled) return;

        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = "copy";
        }
      }

      function handleDragLeave(e: DragEvent) {
        e.preventDefault();
        e.stopPropagation();

        if (disabled) return;

        dragCounterRef.current--;
        if (dragCounterRef.current === 0) {
          setIsDragging(false);
        }
      }

      async function handleDrop(e: DragEvent) {
        e.preventDefault();
        e.stopPropagation();

        setIsDragging(false);
        dragCounterRef.current = 0;

        if (disabled) return;

        const files = Array.from(e.dataTransfer?.files ?? []);
        const imageFiles = files.filter(isImageFile);

        if (imageFiles.length === 0) return;

        try {
          const attachments = await Promise.all(
            imageFiles.map(fileToImageAttachment)
          );
          onFilesDroppedRef.current(attachments);
        } catch (error) {
          console.error("[useFileDropZone] Failed to process dropped files:", error);
        }
      }

      element.addEventListener("dragenter", handleDragEnter);
      element.addEventListener("dragover", handleDragOver);
      element.addEventListener("dragleave", handleDragLeave);
      element.addEventListener("drop", handleDrop);

      cleanup = () => {
        element.removeEventListener("dragenter", handleDragEnter);
        element.removeEventListener("dragover", handleDragOver);
        element.removeEventListener("dragleave", handleDragLeave);
        element.removeEventListener("drop", handleDrop);
      };
    }

    void (async () => {
      const tauriListenersAttached = await setupTauriDragDrop();
      if (disposed || tauriListenersAttached) {
        return;
      }
      setupDomDragDrop();
    })();

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [disabled]);

  return {
    isDragging,
    containerRef,
  };
}
