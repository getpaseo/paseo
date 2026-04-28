import { isElectronRuntime } from "@/desktop/host";
import type { AttachmentStore } from "@/attachments/types";
import { isWeb } from "@/constants/platform";

let attachmentStorePromise: Promise<AttachmentStore> | null = null;

async function createAttachmentStore(): Promise<AttachmentStore> {
  if (isWeb) {
    if (isElectronRuntime()) {
      const { createDesktopAttachmentStore } =
        await import("../desktop/attachments/desktop-attachment-store");
      return createDesktopAttachmentStore();
    }

    const { createIndexedDbAttachmentStore } = await import("./web/indexeddb-attachment-store");
    return createIndexedDbAttachmentStore();
  }

  const { createNativeFileAttachmentStore } = await import("./native/native-file-attachment-store");
  return createNativeFileAttachmentStore();
}

export async function getAttachmentStore(): Promise<AttachmentStore> {
  if (!attachmentStorePromise) {
    attachmentStorePromise = createAttachmentStore();
  }
  return await attachmentStorePromise;
}

/** Test-only hook to inject a deterministic store implementation. */
export function __setAttachmentStoreForTests(store: AttachmentStore | null): void {
  attachmentStorePromise = store ? Promise.resolve(store) : null;
}
