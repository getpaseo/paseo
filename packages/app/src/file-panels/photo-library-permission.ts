/**
 * Photo-library write access is a prompt on iOS and on Android 10. Android 11 and newer save
 * through MediaStore inserts, which need no runtime permission, and asking there returns a
 * permission that the platform ignores.
 */
export function needsPhotoLibraryPermission(platform: string, osVersion: string | number): boolean {
  if (platform === "ios") return true;
  return platform === "android" && Number(osVersion) < 30;
}

export class PhotoLibraryPermissionError extends Error {
  constructor() {
    super("Photo library write permission was not granted.");
    this.name = "PhotoLibraryPermissionError";
  }
}
