import type { MediaType } from "expo-image-picker";
import type { PlatformOSType } from "react-native";

export function resolveImagePickerMediaTypes(platform: PlatformOSType): MediaType[] {
  return platform === "ios" ? ["images", "videos"] : ["images"];
}
