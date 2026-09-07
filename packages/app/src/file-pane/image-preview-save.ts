export interface ImagePreviewLibrary {
  requestSavePermission: () => Promise<boolean>;
  saveToPhotoLibrary: (uri: string) => Promise<void>;
}

export async function savePreviewImage(
  uri: string,
  library: ImagePreviewLibrary,
): Promise<"saved" | "permission-denied"> {
  if (!(await library.requestSavePermission())) {
    return "permission-denied";
  }
  await library.saveToPhotoLibrary(uri);
  return "saved";
}
