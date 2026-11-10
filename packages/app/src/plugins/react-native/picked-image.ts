import type { PickedImage } from "@getpaseo/plugin/client/react-native";

/** What each platform's picker hands back, before it is a plugin `PickedImage`. */
export interface PickerAsset {
  uri: string;
  base64?: string | null;
  mimeType?: string | null;
  fileName?: string | null;
  width: number;
  height: number;
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
};

export function base64ByteLength(base64: string): number {
  let padding = 0;
  if (base64.endsWith("==")) padding = 2;
  else if (base64.endsWith("=")) padding = 1;
  return (base64.length * 3) / 4 - padding;
}

function inferMimeType(name: string): string {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return (extension && MIME_BY_EXTENSION[extension]) ?? "application/octet-stream";
}

/** Null when the platform returned no bytes, which a plugin cannot store. */
export function toPickedImage(asset: PickerAsset): PickedImage | null {
  if (!asset.base64) return null;
  const mimeType = asset.mimeType || inferMimeType(asset.fileName || asset.uri);
  return {
    uri: asset.uri,
    base64: asset.base64,
    mimeType,
    ...(asset.fileName ? { fileName: asset.fileName } : {}),
    width: asset.width,
    height: asset.height,
    byteLength: base64ByteLength(asset.base64),
  };
}
