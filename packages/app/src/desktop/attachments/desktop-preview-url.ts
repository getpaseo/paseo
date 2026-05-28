import type { AttachmentMetadata } from "@/attachments/types";
import { fileUriToPath } from "@/attachments/utils";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import { Buffer } from "buffer";

export interface DesktopFileReader {
  readFileBase64(storageKey: string): Promise<string>;
}

export interface ObjectUrlMinter {
  tryCreate(input: { mimeType: string; base64: string }): string | null;
  revoke(url: string): void;
}

export interface DesktopPreviewUrlResolver {
  resolve(attachment: AttachmentMetadata): Promise<string>;
  release(input: { url: string }): Promise<void>;
}

export async function readDesktopFileBase64(pathOrUri: string): Promise<string> {
  return await invokeDesktopCommand<string>("read_file_base64", {
    path: fileUriToPath(pathOrUri),
  });
}

export function createDesktopFileReader(): DesktopFileReader {
  return { readFileBase64: readDesktopFileBase64 };
}

export function createBrowserObjectUrlMinter(): ObjectUrlMinter {
  return {
    tryCreate({ mimeType, base64 }) {
      if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
        return null;
      }
      const bytes = base64ToUint8Array(base64);
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      const blob = new Blob([buffer], { type: mimeType });
      return URL.createObjectURL(blob);
    },
    revoke(url) {
      if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(url);
      }
    },
  };
}

export function createDesktopPreviewUrlResolver(deps: {
  reader: DesktopFileReader;
  objectUrls: ObjectUrlMinter;
}): DesktopPreviewUrlResolver {
  const tracked = new Set<string>();
  return {
    async resolve(attachment) {
      const base64 = await deps.reader.readFileBase64(attachment.storageKey);
      const url = deps.objectUrls.tryCreate({ mimeType: attachment.mimeType, base64 });
      if (url === null) {
        return `data:${attachment.mimeType};base64,${base64}`;
      }
      tracked.add(url);
      return url;
    },
    async release({ url }) {
      if (!tracked.has(url)) {
        return;
      }
      tracked.delete(url);
      deps.objectUrls.revoke(url);
    },
  };
}

function base64ToUint8Array(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, "base64"));
}
