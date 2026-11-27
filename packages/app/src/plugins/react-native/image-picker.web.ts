import type { PickImagesOptions, PickedImage } from "@getpaseo/plugin/client/react-native";
import { toPickedImage } from "./picked-image";

/** Resolves `[]` when the chooser is dismissed without a choice. */
function chooseFiles(multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = multiple;
    input.addEventListener("change", () => resolve(Array.from(input.files ?? [])), {
      once: true,
    });
    input.addEventListener("cancel", () => resolve([]), { once: true });
    input.click();
  });
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)), { once: true });
    reader.addEventListener(
      "error",
      () => reject(reader.error ?? new Error(`Could not read ${file.name}`)),
      { once: true },
    );
    reader.readAsDataURL(file);
  });
}

async function readImage(file: File): Promise<PickedImage | null> {
  const [dataUrl, bitmap] = await Promise.all([readDataUrl(file), createImageBitmap(file)]);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return toPickedImage({
    uri: dataUrl,
    base64: dataUrl.slice(dataUrl.indexOf(",") + 1),
    mimeType: file.type,
    fileName: file.name,
    ...size,
  });
}

/** Browser and Electron share the DOM file chooser, so plugins need no web branch of their own. */
export async function pickImages(options: PickImagesOptions = {}): Promise<PickedImage[]> {
  const multiple = options.multiple === true;
  const files = (await chooseFiles(multiple)).filter((file) => file.type.startsWith("image/"));
  let chosen = files.slice(0, 1);
  if (multiple) chosen = options.limit ? files.slice(0, options.limit) : files;
  const images = await Promise.all(chosen.map(readImage));
  return images.flatMap((image) => image ?? []);
}
