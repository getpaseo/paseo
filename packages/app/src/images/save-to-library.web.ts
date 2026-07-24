interface SaveImageInput {
  uri: string;
  mimeType?: string;
}

export class ImageLibraryPermissionError extends Error {}

export async function saveImageToLibrary(_input: SaveImageInput): Promise<void> {
  throw new Error("Saving images to the photo library is only supported in native apps.");
}
