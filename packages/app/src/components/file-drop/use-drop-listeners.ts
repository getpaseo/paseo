import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import type { SharedValue } from "react-native-reanimated";
import type { ImageAttachment } from "@/composer/types";
import { getDesktopHost } from "@/desktop/host";
import { persistAttachmentFromBlob, persistAttachmentFromFileUri } from "@/attachments/service";
import {
  isRasterImageFile,
  isRasterImagePath,
  resolveRasterImageMimeType,
} from "@/attachments/file-types";
import { isWeb } from "@/constants/platform";
import type { DroppedItem, DroppedPathItem, FileDropSink } from "./types";
import { classifyDragTypes, readDroppedText, type DragSinkCapabilities } from "./data-transfer";
import {
  parseWorkspaceFileDragPayload,
  WORKSPACE_FILE_DRAG_MIME,
} from "@/attachments/workspace-file-drag";

type DesktopDragDropPayload =
  | { type: "enter"; paths: string[] }
  | { type: "over" }
  | { type: "drop"; paths: string[] }
  | { type: "leave" };

interface DesktopDragDropEvent {
  payload: DesktopDragDropPayload;
}

async function filePathToImageAttachment(path: string): Promise<ImageAttachment> {
  const mimeType = resolveRasterImageMimeType({ path });
  if (!mimeType) {
    throw new Error(`Unsupported image type for '${path}'.`);
  }
  return await persistAttachmentFromFileUri({ uri: path, mimeType });
}

/** Routes a workspace-file payload to the sink, reporting whether the drop was consumed by it. */
function deliverWorkspaceFile(dataTransfer: DataTransfer, sink: FileDropSink): boolean {
  if (!sink.onWorkspaceFile) return false;
  const serialized = dataTransfer.getData(WORKSPACE_FILE_DRAG_MIME);
  if (!serialized) return false;
  const payload = parseWorkspaceFileDragPayload(serialized);
  if (!payload) return false;
  sink.onWorkspaceFile(payload);
  return true;
}

async function fileToImageAttachment(file: File): Promise<ImageAttachment> {
  const mimeType = resolveRasterImageMimeType({ mimeType: file.type, path: file.name });
  if (!mimeType) {
    throw new Error(`Unsupported image type for '${file.name}'.`);
  }
  return await persistAttachmentFromBlob({
    blob: file,
    mimeType,
    fileName: file.name,
  });
}

interface UseDropListenersOptions {
  isDragging: SharedValue<boolean>;
  /** Whether the in-progress drag carries text rather than files, so the overlay can say so. */
  isTextDrag: SharedValue<boolean>;
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
  isTextDrag,
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

      function sinkCapabilities(): DragSinkCapabilities {
        const sink = getSink();
        return {
          acceptsWorkspaceFile: Boolean(sink?.onWorkspaceFile),
          acceptsText: Boolean(sink?.onText),
        };
      }

      function handleDragEnter(e: DragEvent) {
        e.preventDefault();
        e.stopPropagation();

        if (disabledRef.current) return;

        dragCounter.current++;
        if (suppressed.value || !hasSink.value) return;
        const drag = classifyDragTypes(e.dataTransfer?.types ?? [], sinkCapabilities());
        if (!drag.isAccepted) return;
        // The only write: the value is meaningless unless a drag is active, and clearing it when
        // the drag ends would flip the overlay's label mid fade-out.
        isTextDrag.value = drag.isTextDrag;
        isDragging.value = true;
      }

      function handleDragOver(e: DragEvent) {
        e.preventDefault();
        e.stopPropagation();

        if (!e.dataTransfer) return;
        // Only advertise "copy" when the drop would actually be accepted, so the cursor doesn't
        // promise a drop that the handler then discards (suppressed/archived/no consumer mounted).
        const drag = classifyDragTypes(e.dataTransfer.types, sinkCapabilities());
        const canAccept =
          drag.isAccepted && !disabledRef.current && !suppressed.value && hasSink.value;
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

        const dataTransfer = e.dataTransfer;
        if (!dataTransfer) return;

        const consumedWorkspaceFile = deliverWorkspaceFile(dataTransfer, sink);

        const files = Array.from(dataTransfer.files);
        const genericItems: DroppedItem[] = files.map((file) => ({
          kind: "web-file",
          file,
        }));

        if (sink.onGenericFiles && genericItems.length > 0) {
          sink.onGenericFiles(genericItems);
        }

        // A drop carries text only as a description of its real payload when it also carries files
        // (Finder) or a workspace file (a drag from the file tree), so text is what's left over.
        if (files.length === 0 && !consumedWorkspaceFile && sink.onText) {
          const text = readDroppedText(dataTransfer);
          if (text) {
            sink.onText(text);
          }
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
  }, [isDragging, isTextDrag, suppressed, hasSink, getSink]);

  return containerRef;
}
