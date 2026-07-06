import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import type { SharedValue } from "react-native-reanimated";
import type { ImageAttachment } from "@/composer/types";
import { getDesktopHost } from "@/desktop/host";
import { persistAttachmentFromBlob, persistAttachmentFromFileUri } from "@/attachments/service";
import {
  getRasterImageMimeTypeFromPath,
  isRasterImageFile,
  isRasterImagePath,
} from "@/attachments/file-types";
import { isWeb } from "@/constants/platform";
import type { DroppedItem, DroppedPathItem, FileDropSink } from "./types";

type DesktopDragDropPayload =
  | { type: "enter"; paths: string[] }
  | { type: "over" }
  | { type: "drop"; paths: string[] }
  | { type: "leave" };

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

interface UseDropListenersOptions {
  isDragging: SharedValue<boolean>;
  /** Active sink can't accept right now: reject drops without showing acceptance. */
  suppressed: SharedValue<boolean>;
  /** Whether a consumer is mounted: with none, don't advertise or accept drops. */
  hasSink: SharedValue<boolean>;
  /** Stable getter for the currently registered sink. */
  getSink: () => FileDropSink | null;
  disabled: boolean;
}

/**
 * Attaches web/desktop drag-and-drop listeners to the returned element ref. Drag state is
 * written to a shared value (no React renders); dropped files are routed to the active sink.
 */
export function useDropListeners({
  isDragging,
  suppressed,
  hasSink,
  getSink,
  disabled,
}: UseDropListenersOptions): RefObject<HTMLElement | null> {
  const containerRef = useRef<HTMLElement | null>(null);
  const dragCounter = useRef(0);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  // Clear an in-progress drag when the zone becomes disabled.
  useEffect(() => {
    if (disabled) {
      isDragging.value = false;
      dragCounter.current = 0;
    }
  }, [disabled, isDragging]);

  useEffect(() => {
    if (!isWeb) return;

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
          console.warn("[useDropListeners] Failed to remove desktop drag-drop listener:", error);
        });
      } catch (error) {
        console.warn("[useDropListeners] Failed to remove desktop drag-drop listener:", error);
      }
    }

    // Desktop drag-drop (Tauri-style) is window-scoped, not element-scoped: with multiple zones
    // mounted, every zone would react to the same drop. Dormant today — current Electron does not
    // expose onDragDropEvent, so the element-scoped HTML5 DOM path below is what actually runs.
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
            isDragging.value = false;
            return;
          }

          if (payload.type === "enter" || payload.type === "over") {
            if (!disabledRef.current) {
              isDragging.value = true;
            }
            return;
          }

          // Drop always ends the current drag operation.
          isDragging.value = false;

          if (disabledRef.current || suppressed.value) return;

          const sink = getSink();
          if (!sink) return;

          const items: DroppedPathItem[] = payload.paths.map((path) => ({
            kind: "desktop-path",
            path,
          }));

          if (sink.onGenericFiles && items.length > 0) {
            sink.onGenericFiles(items);
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
              // Use the sink captured at drop time, not a fresh getSink() — routing belongs to the
              // composer the user dropped on (matches the web path below). No post-persist busy
              // re-check: a mixed drop's own generic upload flips the busy flag, and re-checking
              // would discard the image from the same drop.
              sink.onFiles(attachments);
              return;
            })
            .catch((error) => {
              console.error("[useDropListeners] Failed to persist dropped files:", error);
            });
        });

        if (disposed) {
          runCleanup(unlisten);
          return true;
        }

        cleanup = unlisten;
        return true;
      } catch (error) {
        console.warn("[useDropListeners] Failed to listen for desktop drag-drop:", error);
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

        if (disabledRef.current) return;

        dragCounter.current++;
        if (e.dataTransfer?.types.includes("Files")) {
          isDragging.value = true;
        }
      }

      function handleDragOver(e: DragEvent) {
        e.preventDefault();
        e.stopPropagation();

        if (!e.dataTransfer) return;
        // Only advertise "copy" when the drop would actually be accepted, so the cursor doesn't
        // promise a drop that the handler then discards (suppressed/archived/no consumer mounted).
        const canAccept = !disabledRef.current && !suppressed.value && hasSink.value;
        e.dataTransfer.dropEffect = canAccept ? "copy" : "none";
      }

      function handleDragLeave(e: DragEvent) {
        e.preventDefault();
        e.stopPropagation();

        if (disabledRef.current) return;

        dragCounter.current--;
        if (dragCounter.current === 0) {
          isDragging.value = false;
        }
      }

      async function handleDrop(e: DragEvent) {
        e.preventDefault();
        e.stopPropagation();

        isDragging.value = false;
        dragCounter.current = 0;

        if (disabledRef.current || suppressed.value) return;

        const sink = getSink();
        if (!sink) return;

        const files = Array.from(e.dataTransfer?.files ?? []);
        const genericItems: DroppedItem[] = files.map((file) => ({
          kind: "web-file",
          file,
        }));

        if (sink.onGenericFiles && genericItems.length > 0) {
          sink.onGenericFiles(genericItems);
        }

        const imageFiles = files.filter(isRasterImageFile);

        if (imageFiles.length === 0) return;

        try {
          const attachments = await Promise.all(imageFiles.map(fileToImageAttachment));
          // No post-persist busy re-check: a mixed drop's own generic upload flips the busy flag,
          // and re-checking would discard the image from the same drop. The guard at drop start
          // already rejects drops that begin while busy.
          sink.onFiles(attachments);
        } catch (error) {
          console.error("[useDropListeners] Failed to process dropped files:", error);
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
  }, [isDragging, suppressed, hasSink, getSink]);

  return containerRef;
}
