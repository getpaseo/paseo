type ImageDecoder = (
  uri: string,
  success: (width: number, height: number) => void,
  failure: (error: unknown) => void,
) => void;

export function decodeMarkdownImage(uri: string, decode: ImageDecoder): Promise<true> {
  return new Promise((resolve, reject) => {
    decode(
      uri,
      (width, height) => {
        if (width > 0 && height > 0) resolve(true);
        else reject(new Error("Image has no decodable dimensions"));
      },
      reject,
    );
  });
}

interface MarkdownImageLoadState {
  canAcquire: boolean;
  url: string | undefined;
  acquisitionFailed: boolean;
  decodeFailed: boolean;
  decoded: boolean;
}

export function getMarkdownImageStatus(
  state: MarkdownImageLoadState,
): "pending" | "ready" | "unavailable" {
  const cannotResolve = !state.canAcquire && state.url === undefined;
  if (cannotResolve || state.acquisitionFailed || state.decodeFailed) return "unavailable";
  return state.decoded ? "ready" : "pending";
}
