/**
 * Saving needs the native photo library. The button that calls this is only rendered on native
 * (`ImagePanel`), so web and Electron never reach it.
 */
export async function saveImageToAlbum(_uri: string): Promise<void> {
  throw new Error("Saving to the photo library is only available in the mobile app.");
}
