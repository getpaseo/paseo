import { dialog, promises } from "@react-native-gpui/fs";
// Linux exports a downloaded file through the native Save dialog.
export const isAvailableAsync = async () => true;
export async function shareAsync(uri, options = {}) {
  const source = uri.replace(/^file:\/\//, "");
  const destination = await dialog.save({
    title: options.dialogTitle ?? "Save file",
    defaultName: source.split("/").at(-1),
  });
  if (destination) await promises.copyFile(source, destination);
}
