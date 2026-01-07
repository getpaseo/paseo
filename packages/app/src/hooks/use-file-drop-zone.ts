import { useState, useCallback, useRef, useEffect } from "react";
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

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
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

    const element = containerRef.current;
    if (!element) return;

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

    return () => {
      element.removeEventListener("dragenter", handleDragEnter);
      element.removeEventListener("dragover", handleDragOver);
      element.removeEventListener("dragleave", handleDragLeave);
      element.removeEventListener("drop", handleDrop);
    };
  }, [disabled]);

  return {
    isDragging,
    containerRef,
  };
}
