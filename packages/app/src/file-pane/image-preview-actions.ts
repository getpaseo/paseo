export interface ImagePreviewActionPort {
  requestSavePermission: () => Promise<boolean>;
  saveToPhotoLibrary: (uri: string) => Promise<void>;
  share: (input: { uri: string; mimeType: string; fileName: string }) => Promise<void>;
}

export async function savePreviewImage(
  uri: string,
  port: ImagePreviewActionPort,
): Promise<"saved" | "permission-denied"> {
  if (!(await port.requestSavePermission())) {
    return "permission-denied";
  }
  await port.saveToPhotoLibrary(uri);
  return "saved";
}

export async function sharePreviewImage(
  input: { uri: string; mimeType: string; fileName: string },
  port: ImagePreviewActionPort,
): Promise<void> {
  await port.share(input);
}
