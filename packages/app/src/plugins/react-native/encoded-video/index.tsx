import { forwardRef, useEffect, useRef } from "react";
import type { EncodedVideoHandle, EncodedVideoProps } from "@getpaseo/plugin/client/react-native";

/** Native platforms without the Android decoder report a capability failure once per mount. */
export const EncodedVideo = forwardRef<EncodedVideoHandle, EncodedVideoProps>(function EncodedVideo(
  { onError },
  _ref,
) {
  const callback = useRef(onError);
  callback.current = onError;
  useEffect(() => {
    callback.current(new Error("Encoded video is unavailable on this platform"));
  }, []);
  return null;
});
