import type { AttachmentMetadata } from "@/attachments/types";
import { fileUriToPath } from "@/attachments/utils";
import { invokeDesktopCommand } from "@/desktop/tauri/invoke-desktop-command";

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

const activeObjectUrls = new Set<string>();

export async function readDesktopFileBase64(pathOrUri: string): Promise<string> {
  return await invokeDesktopCommand<string>("read_file_base64", {
    path: fileUriToPath(pathOrUri),
  });
}

export async function resolveDesktopPreviewUrl(
  attachment: AttachmentMetadata
): Promise<string> {
  const base64 = await readDesktopFileBase64(attachment.storageKey);

  if (
    typeof URL !== "undefined" &&
    typeof URL.createObjectURL === "function"
  ) {
    const bytes = base64ToUint8Array(base64);
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    const blob = new Blob([buffer], { type: attachment.mimeType });
    const objectUrl = URL.createObjectURL(blob);
    activeObjectUrls.add(objectUrl);
    return objectUrl;
  }

  return `data:${attachment.mimeType};base64,${base64}`;
}

export async function releaseDesktopPreviewUrl(input: {
  url: string;
}): Promise<void> {
  if (!activeObjectUrls.has(input.url)) {
    return;
  }
  activeObjectUrls.delete(input.url);

  if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(input.url);
  }
}

export const __desktopPreviewUrlTestUtils = {
  base64ToUint8Array,
  clearActiveObjectUrls: () => {
    activeObjectUrls.clear();
  },
};
