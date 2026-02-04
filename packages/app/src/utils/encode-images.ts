import { Platform } from "react-native";
import { File } from "expo-file-system";

type ImageInput = { uri: string; mimeType?: string };

export async function encodeImages(
  images?: ImageInput[]
): Promise<Array<{ data: string; mimeType: string }> | undefined> {
  if (!images || images.length === 0) {
    return undefined;
  }

  const encodedImages = await Promise.all(
    images.map(async ({ uri, mimeType }) => {
      try {
        const data = await (async () => {
          if (Platform.OS === "web") {
            if (uri.startsWith("data:")) {
              const [, base64] = uri.split(",", 2);
              if (!base64) {
                throw new Error("Malformed data URI for image.");
              }
              return base64;
            }
            const response = await fetch(uri);
            const blob = await response.blob();
            const base64 = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => {
                if (typeof reader.result !== "string") {
                  reject(new Error("Unexpected FileReader result type."));
                  return;
                }
                const [, resultBase64] = reader.result.split(",", 2);
                if (!resultBase64) {
                  reject(new Error("Failed to read image data as base64."));
                  return;
                }
                resolve(resultBase64);
              };
              reader.onerror = () => {
                reject(reader.error ?? new Error("Failed to read image data."));
              };
              reader.readAsDataURL(blob);
            });
            return base64;
          }

          const file = new File(uri);
          return await file.base64();
        })();

        return {
          data,
          mimeType: mimeType ?? "image/jpeg",
        };
      } catch (error) {
        console.error("[encodeImages] Failed to convert image:", error);
        return null;
      }
    })
  );

  const validImages = encodedImages.filter(
    (entry): entry is { data: string; mimeType: string } => entry !== null
  );
  return validImages.length > 0 ? validImages : undefined;
}
