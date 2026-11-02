// The GPUI picker accepts JPEG/PNG directly. Other formats require a future
// native decoder; never claim conversion succeeded for an unsupported format.
export const SaveFormat = { PNG: "png", JPEG: "jpeg", WEBP: "webp" };
export const ImageManipulator = {
  manipulate() {
    throw new Error("Image conversion is not available in the GPUI build; select a PNG or JPEG.");
  },
};
