import { dialog, promises } from "@react-native-gpui/fs";
export async function getDocumentAsync(options = {}) {
  const paths = await dialog.open({ multiple: options.multiple ?? false });
  return {
    canceled: paths.length === 0,
    assets: await Promise.all(
      paths.map(async (path) => ({
        uri: `file://${path}`,
        name: path.split("/").at(-1),
        size: (await promises.stat(path)).size,
      })),
    ),
  };
}
