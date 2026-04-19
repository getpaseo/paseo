import { useCallback, useState } from "react";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { presignUpload, type ChatAttachment } from "@/api/chat";
import { isWeb } from "@/constants/platform";

export interface PendingUpload {
  localId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  status: "uploading" | "ready" | "error";
  error?: string;
  attachment?: ChatAttachment;
  localPreviewUri?: string;
}

export interface UseUploadsResult {
  pending: PendingUpload[];
  pickImage: () => Promise<void>;
  pickFile: () => Promise<void>;
  remove: (localId: string) => void;
  reset: () => void;
  /** Returns only the fully uploaded attachments, ready to be sent. */
  collectReady: () => ChatAttachment[];
  hasPending: boolean;
}

export function useUploads(params: {
  orgId: string;
  sessionToken: string | null;
}): UseUploadsResult {
  const [pending, setPending] = useState<PendingUpload[]>([]);

  const patch = (localId: string, patch: Partial<PendingUpload>) =>
    setPending((prev) =>
      prev.map((p) => (p.localId === localId ? { ...p, ...patch } : p)),
    );

  const uploadOne = async (opts: {
    uri: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    width?: number | null;
    height?: number | null;
  }) => {
    const localId = `pending_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    setPending((prev) => [
      ...prev,
      {
        localId,
        filename: opts.filename,
        mimeType: opts.mimeType,
        sizeBytes: opts.sizeBytes,
        status: "uploading",
        localPreviewUri: opts.mimeType.startsWith("image/") ? opts.uri : undefined,
      },
    ]);

    try {
      const presigned = await presignUpload({
        orgId: params.orgId,
        sessionToken: params.sessionToken,
        filename: opts.filename,
        mimeType: opts.mimeType,
        sizeBytes: opts.sizeBytes || 1,
      });
      const blob = await fetchAsBlob(opts.uri, opts.mimeType);
      const putRes = await fetch(presigned.url, {
        method: "PUT",
        body: blob,
        headers: presigned.headers,
      });
      if (!putRes.ok) throw new Error(`Upload failed: HTTP ${putRes.status}`);

      patch(localId, {
        status: "ready",
        attachment: {
          id: presigned.key,
          url: presigned.publicUrl,
          mimeType: opts.mimeType,
          filename: opts.filename,
          sizeBytes: opts.sizeBytes || 0,
          width: opts.width ?? null,
          height: opts.height ?? null,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Upload failed";
      patch(localId, { status: "error", error: message });
    }
  };

  const pickImage = useCallback(async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.All,
      quality: 0.9,
      allowsEditing: false,
    });
    if (result.canceled || result.assets.length === 0) return;
    for (const asset of result.assets) {
      const filename =
        asset.fileName ??
        inferFilename(asset.uri) ??
        `upload_${Date.now()}.bin`;
      const mimeType =
        asset.mimeType ?? (asset.type === "video" ? "video/mp4" : "image/jpeg");
      await uploadOne({
        uri: asset.uri,
        filename,
        mimeType,
        sizeBytes: asset.fileSize ?? 0,
        width: asset.width ?? null,
        height: asset.height ?? null,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.orgId, params.sessionToken]);

  const pickFile = useCallback(async () => {
    const result = await DocumentPicker.getDocumentAsync({
      multiple: true,
      copyToCacheDirectory: true,
    });
    if (result.canceled || result.assets.length === 0) return;
    for (const asset of result.assets) {
      await uploadOne({
        uri: asset.uri,
        filename:
          asset.name ?? inferFilename(asset.uri) ?? `upload_${Date.now()}.bin`,
        mimeType: asset.mimeType ?? "application/octet-stream",
        sizeBytes: asset.size ?? 0,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.orgId, params.sessionToken]);

  const remove = useCallback((localId: string) => {
    setPending((prev) => prev.filter((p) => p.localId !== localId));
  }, []);

  const reset = useCallback(() => setPending([]), []);

  const collectReady = useCallback(
    (): ChatAttachment[] =>
      pending
        .filter((p) => p.status === "ready" && p.attachment)
        .map((p) => p.attachment!),
    [pending],
  );

  return {
    pending,
    pickImage,
    pickFile,
    remove,
    reset,
    collectReady,
    hasPending: pending.length > 0,
  };
}

async function fetchAsBlob(uri: string, mimeType: string): Promise<Blob> {
  // RN + RNW both support fetch on file:// / asset:// URIs to get Blob.
  const res = await fetch(uri);
  const blob = await res.blob();
  // On Android the blob's type is sometimes empty; patch it so the PUT
  // matches the signed ContentType exactly.
  if (!blob.type && !isWeb) {
    return new Blob([blob], { type: mimeType });
  }
  return blob;
}

function inferFilename(uri: string): string | null {
  try {
    const last = uri.split("/").pop();
    if (!last) return null;
    return decodeURIComponent(last.split("?")[0] ?? last);
  } catch {
    return null;
  }
}
