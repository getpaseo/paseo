import type { PickFilesOptions, PickedFile } from "@getpaseo/plugin/client/react-native";
import { toPickedFile } from "./picked-file";

/** Resolves `[]` when the chooser is dismissed without a choice. */
function chooseFiles(multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = multiple;
    input.addEventListener("change", () => resolve(Array.from(input.files ?? [])), {
      once: true,
    });
    input.addEventListener("cancel", () => resolve([]), { once: true });
    input.click();
  });
}

/**
 * A `File` is a handle the browser keeps for the page's life, so a slice reads straight from
 * disk. A file changed or removed since the pick makes the reader fail, and the read rejects.
 */
function readSlice(file: File, offset: number, length: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(new Uint8Array(reader.result as ArrayBuffer)), {
      once: true,
    });
    reader.addEventListener(
      "error",
      () => reject(reader.error ?? new Error(`Could not read ${file.name}`)),
      { once: true },
    );
    reader.readAsArrayBuffer(file.slice(offset, offset + length));
  });
}

/** Browser and Electron share the DOM file chooser, so plugins need no web branch of their own. */
export async function pickFiles(options: PickFilesOptions = {}): Promise<PickedFile[]> {
  const multiple = options.multiple === true;
  const files = await chooseFiles(multiple);
  return (multiple ? files : files.slice(0, 1)).map((file) =>
    toPickedFile({
      fileName: file.name,
      mimeType: file.type,
      byteLength: file.size,
      readBytes: (offset, length) => readSlice(file, offset, length),
    }),
  );
}
