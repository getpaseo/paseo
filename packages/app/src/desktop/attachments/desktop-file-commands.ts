import { invokeDesktopCommand } from "@/desktop/electron/invoke";

interface AttachmentFileResult {
  path: string;
  byteSize: number;
}

export async function writeDesktopAttachmentBase64(input: {
  attachmentId: string;
  base64: string;
  extension?: string | null;
}): Promise<AttachmentFileResult> {
  return await invokeDesktopCommand<AttachmentFileResult>("write_attachment_base64", {
    attachmentId: input.attachmentId,
    base64: input.base64,
    extension: input.extension ?? null,
  });
}

export async function writeDesktopAttachmentBytes(input: {
  attachmentId: string;
  bytes: Uint8Array;
  extension?: string | null;
}): Promise<AttachmentFileResult> {
  return await invokeDesktopCommand<AttachmentFileResult>("write_attachment_bytes", {
    attachmentId: input.attachmentId,
    bytes: input.bytes,
    extension: input.extension ?? null,
  });
}

export async function copyDesktopAttachmentFile(input: {
  attachmentId: string;
  sourcePath: string;
  extension?: string | null;
}): Promise<AttachmentFileResult> {
  return await invokeDesktopCommand<AttachmentFileResult>("copy_attachment_file", {
    attachmentId: input.attachmentId,
    sourcePath: input.sourcePath,
    extension: input.extension ?? null,
  });
}

export async function deleteDesktopAttachmentFile(input: { path: string }): Promise<boolean> {
  return await invokeDesktopCommand<boolean>("delete_attachment_file", {
    path: input.path,
  });
}

export async function garbageCollectDesktopAttachmentFiles(input: {
  referencedIds: readonly string[];
}): Promise<number> {
  return await invokeDesktopCommand<number>("garbage_collect_attachment_files", {
    referencedIds: [...input.referencedIds],
  });
}
