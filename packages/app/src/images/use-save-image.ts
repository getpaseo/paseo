import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import { ImageLibraryPermissionError, saveImageToLibrary } from "./save-to-library";

export interface UseSaveImageInput {
  uri: string | null;
  mimeType?: string;
}

export type ImageSaveStatus = "idle" | "saving" | "saved" | "permissionDenied" | "failed";

export interface UseSaveImageResult {
  save: () => void;
  status: ImageSaveStatus;
}

export function useSaveImage({ uri, mimeType }: UseSaveImageInput): UseSaveImageResult {
  const { t } = useTranslation();
  const toast = useToast();
  const isSaving = useRef(false);
  const operationId = useRef(0);
  const latestSaveOperationId = useRef(0);
  const [status, setStatus] = useState<ImageSaveStatus>("idle");

  useEffect(() => {
    if (status !== "saved") {
      return;
    }
    const timeout = setTimeout(() => setStatus("idle"), 2400);
    return () => clearTimeout(timeout);
  }, [status]);

  useEffect(() => {
    operationId.current += 1;
    isSaving.current = false;
    setStatus("idle");
  }, [mimeType, uri]);

  const save = useCallback(() => {
    if (!uri || isSaving.current) {
      return;
    }

    isSaving.current = true;
    const currentOperationId = operationId.current + 1;
    operationId.current = currentOperationId;
    latestSaveOperationId.current = currentOperationId;
    setStatus("saving");
    toast.show(t("message.attachments.imageSaving"), { durationMs: null });
    void (async () => {
      try {
        await saveImageToLibrary({ uri, mimeType });
        if (operationId.current === currentOperationId) {
          setStatus("saved");
        }
        if (latestSaveOperationId.current === currentOperationId) {
          toast.show(t("message.attachments.imageSaved"), { variant: "success" });
        }
      } catch (error) {
        const isPermissionDenied = error instanceof ImageLibraryPermissionError;
        const message = isPermissionDenied
          ? t("message.attachments.imageSavePermissionDenied")
          : t("message.attachments.imageSaveFailed");
        if (operationId.current === currentOperationId) {
          setStatus(isPermissionDenied ? "permissionDenied" : "failed");
        }
        if (latestSaveOperationId.current === currentOperationId) {
          toast.error(message);
        }
      } finally {
        if (latestSaveOperationId.current === currentOperationId) {
          isSaving.current = false;
        }
      }
    })();
  }, [mimeType, t, toast, uri]);

  return { save, status };
}
