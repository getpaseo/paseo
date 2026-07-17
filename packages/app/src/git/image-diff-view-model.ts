import type { TFunction } from "i18next";
import type { ImageDiffPayload } from "./use-image-diff-query";

export type ImageSidePayload = ImageDiffPayload["oldImage"];
export type AvailableImage = Extract<ImageSidePayload, { status: "available" }>;

export function imageStatusLabel(
  status: Exclude<ImageSidePayload, { status: "available" | "missing" }>,
  t: TFunction,
): string {
  switch (status.status) {
    case "too_large":
      return `${t("workspace.git.imageDiff.tooLarge")} (${formatImageDiffSize(status.size)})`;
    case "unsupported":
      return t("workspace.git.imageDiff.unsupported");
    case "read_error":
      return status.message || t("workspace.git.imageDiff.readError");
    case "invalid":
      return status.message || t("workspace.git.imageDiff.invalid");
  }
}

export function imageUri(image: AvailableImage): string {
  return `data:${image.mimeType};base64,${image.content}`;
}

export function formatImageDiffSize(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
