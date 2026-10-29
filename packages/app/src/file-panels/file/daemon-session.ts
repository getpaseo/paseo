import type { DaemonClient, FileReadResult } from "@getpaseo/client/internal/daemon-client";
import type { FileVersion } from "@getpaseo/protocol/messages";
import {
  persistAttachmentFromBytes,
  releaseAttachmentPreviewUrl,
  resolveAttachmentPreviewUrl,
} from "@/attachments/service";
import { createPreviewAttachmentId, getFileNameFromPath } from "@/attachments/utils";
import type { FileKind, FileObservation, FileSession } from "./handle";

export interface DaemonFileFeatures {
  // COMPAT(workspaceFileEditing): added in v0.2.0, remove after 2027-01-18 once daemon floor >= v0.2.0.
  workspaceFileEditing: boolean;
  // COMPAT(fileByteWrites): added in v0.13.0, remove gate after 2027-04-20.
  fileByteWrites: boolean;
}

/** A file session over a daemon connection. */
export function createDaemonFileSession(
  client: DaemonClient,
  features: DaemonFileFeatures,
): FileSession {
  return {
    async observe(target, onObservation) {
      if (!features.workspaceFileEditing) {
        // COMPAT(workspaceFileEditing): the host cannot observe files; its read is the stat.
        return {
          initial: statFromRead(await client.readFile(target.cwd, target.path)),
          unsubscribe() {},
        };
      }
      let kind: { kind: FileKind; mimeType: string } | null = null;
      const classify = (version: FileVersion): FileObservation => {
        if (version.status !== "ready") return version;
        if (version.kind && version.mimeType) {
          kind = { kind: version.kind, mimeType: version.mimeType };
        }
        // COMPAT(fileVersionKind): added in v0.13.0, remove after 2027-04-20. Older daemons
        // classify a file only when reading it; the first read's kind stands for later versions.
        if (!kind) return { ...version, status: "error", error: "The file has no kind." };
        return { ...version, ...kind };
      };
      const subscription = await client.subscribeFile(target, (version) =>
        onObservation(classify(version)),
      );
      const initial = subscription.initial;
      if (initial.status === "ready" && !initial.kind) {
        // COMPAT(fileVersionKind): see above.
        const read = statFromRead(await client.readFile(target.cwd, target.path));
        kind = { kind: read.kind, mimeType: read.mimeType };
      }
      return {
        initial: classify(initial),
        unsubscribe() {
          void subscription.unsubscribe();
        },
      };
    },
    async read(target) {
      return client.readFile(target.cwd, target.path);
    },
    async write({ target, content, ...expected }) {
      if (!features.workspaceFileEditing) throw new Error("Update the host to edit files.");
      if (typeof content === "string") {
        return client.writeFile({ ...target, content, ...expected });
      }
      if (!features.fileByteWrites) throw new Error("Update the host to write binary files.");
      return client.writeFile({
        ...target,
        content: bytesToBase64(content),
        contentEncoding: "base64",
        ...expected,
      });
    },
    async createUrl({ target, bytes, mimeType }) {
      const attachment = await persistAttachmentFromBytes({
        id: createPreviewAttachmentId({
          mimeType,
          path: `${target.cwd}/${target.path}`,
          contentLength: bytes.byteLength,
          contentKey: String(Date.now()),
        }),
        bytes,
        mimeType,
        fileName: getFileNameFromPath(target.path),
      });
      const url = await resolveAttachmentPreviewUrl(attachment);
      return {
        url,
        release() {
          void releaseAttachmentPreviewUrl({ attachment, url });
        },
      };
    },
  };
}

function statFromRead(file: FileReadResult): Extract<FileObservation, { status: "ready" }> {
  return {
    status: "ready",
    size: file.size,
    modifiedAt: file.modifiedAt,
    revision: file.revision,
    kind: file.kind,
    mimeType: file.mime,
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}
