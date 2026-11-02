import { dialog, promises } from "@react-native-gpui/fs";
// Desktop access is granted for each selection by the system file dialog.
export const PermissionStatus = {
  GRANTED: "granted",
  DENIED: "denied",
  UNDETERMINED: "undetermined",
};
const permission = { status: "granted", granted: true, canAskAgain: true, expires: "never" };
export const requestMediaLibraryPermissionsAsync = async () => permission;
export const useMediaLibraryPermissions = () => [permission, requestMediaLibraryPermissionsAsync];
export const getPendingResultAsync = async () => null;
export async function launchImageLibraryAsync(options = {}) {
  const paths = await dialog.open({
    multiple: options.allowsMultipleSelection,
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }],
  });
  return {
    canceled: !paths.length,
    assets: await Promise.all(
      paths.map(async (path) => ({
        uri: `file://${path}`,
        fileName: path.split("/").at(-1),
        fileSize: (await promises.stat(path)).size,
        mimeType: /\.png$/i.test(path) ? "image/png" : "image/jpeg",
      })),
    ),
  };
}
