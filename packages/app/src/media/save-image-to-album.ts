/**
 * Saving needs the native photo library. The image lightbox only offers the action on native, so
 * web and Electron never reach this.
 */
export async function saveImageToAlbum(_uri: string): Promise<void> {
  throw new Error("Saving to the photo library is only available in the mobile app.");
}
