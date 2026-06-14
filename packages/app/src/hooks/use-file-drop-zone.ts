import { useState, useRef, useEffect } from "react";
import type { ImageAttachment } from "@/composer/types";
import { getDesktopHost } from "@/desktop/host";
import { persistAttachmentFromBlob, persistAttachmentFromFileUri } from "@/attachments/service";
import {
  getRasterImageMimeTypeFromPath,
  isRasterImageFile,
  isRasterImagePath,
} from "@/attachments/file-types";
import { isWeb } from "@/constants/platform";

export interface DroppedFileItem {
  kind: "web-file";
  file: File;
}
export interface DroppedPathItem {
  kind: "desktop-path";
  path: string;
}
export type DroppedItem = DroppedFileItem | DroppedPathItem;

interface UseFileDropZoneOptions {
  onFilesDropped: (files: ImageAttachment[]) => void;
  onGenericFilesDropped?: (items: DroppedItem[]) => void;
  disabled?: boolean;
}

interface UseFileDropZoneReturn {
  isDragging: boolean;
  containerRef: React.RefObject<HTMLElement | null>;
}

const IS_WEB = isWeb;

type DesktopDragDropPayload =
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

interface DesktopDragDropEvent {
  payload: DesktopDragDropPayload;
}

async function filePathToImageAttachment(path: string): Promise<ImageAttachment> {
  const mimeType = getRasterImageMimeTypeFromPath(path) ?? "image/jpeg";
  return await persistAttachmentFromFileUri({ uri: path, mimeType });
}

async function fileToImageAttachment(file: File): Promise<ImageAttachment> {
  return await persistAttachmentFromBlob({
    blob: file,
    mimeType: file.type || "image/jpeg",
    fileName: file.name,
  });
}

export function useFileDropZone({
  onFilesDropped,
  onGenericFilesDropped,
  disabled = false,
}: UseFileDropZoneOptions): UseFileDropZoneReturn {
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLElement | null>(null);
  const dragCounterRef = useRef(0);
  const onFilesDroppedRef = useRef(onFilesDropped);
  const onGenericFilesDroppedRef = useRef(onGenericFilesDropped);

  // Keep callback refs up to date
  useEffect(() => {
    onFilesDroppedRef.current = onFilesDropped;
  }, [onFilesDropped]);

  useEffect(() => {
    onGenericFilesDroppedRef.current = onGenericFilesDropped;
  }, [onGenericFilesDropped]);

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
    let didCleanup = false;

    function runCleanup(unlisten?: () => void | Promise<void>) {
      if (didCleanup) return;
      const cleanupFn = unlisten ?? cleanup;
      if (!cleanupFn) return;
      didCleanup = true;
      try {
        void Promise.resolve(cleanupFn()).catch((error) => {
          console.warn("[useFileDropZone] Failed to remove desktop drag-drop listener:", error);
        });
      } catch (error) {
        console.warn("[useFileDropZone] Failed to remove desktop drag-drop listener:", error);
      }
    }

    async function setupDesktopDragDrop(): Promise<boolean> {
      const desktopHost = getDesktopHost();
      if (desktopHost === null) {
        return false;
      }

      const desktopWindow = desktopHost.window?.getCurrentWindow?.();
      if (!desktopWindow || typeof desktopWindow.onDragDropEvent !== "function") {
        return false;
      }

      try {
        const unlisten = await desktopWindow.onDragDropEvent((event: DesktopDragDropEvent) => {
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

          const items: DroppedPathItem[] = payload.paths.map((path) => ({
            kind: "desktop-path",
            path,
          }));

          if (onGenericFilesDroppedRef.current && items.length > 0) {
            onGenericFilesDroppedRef.current(items);
          }

          const imagePaths = payload.paths.filter(isRasterImagePath);
          if (imagePaths.length === 0) {
            return;
          }

          void Promise.all(imagePaths.map(filePathToImageAttachment))
            .then((attachments) => {
              if (attachments.length === 0) {
                return;
              }
              onFilesDroppedRef.current(attachments);
              return;
            })
            .catch((error) => {
              console.error("[useFileDropZone] Failed to persist dropped files:", error);
            });
        });

        if (disposed) {
          runCleanup(unlisten);
          return true;
        }

        cleanup = unlisten;
        return true;
      } catch (error) {
        console.warn("[useFileDropZone] Failed to listen for desktop drag-drop:", error);
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
        const genericItems: DroppedItem[] = files.map((file) => ({
          kind: "web-file",
          file,
        }));

        if (onGenericFilesDroppedRef.current && genericItems.length > 0) {
          onGenericFilesDroppedRef.current(genericItems);
        }

        const imageFiles = files.filter(isRasterImageFile);

        if (imageFiles.length === 0) return;

        try {
          const attachments = await Promise.all(imageFiles.map(fileToImageAttachment));
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
      const desktopListenersAttached = await setupDesktopDragDrop();
      if (disposed || desktopListenersAttached) {
        return;
      }
      setupDomDragDrop();
    })();

    return () => {
      disposed = true;
      runCleanup();
    };
  }, [disabled]);

  return {
    isDragging,
    containerRef,
  };
}
