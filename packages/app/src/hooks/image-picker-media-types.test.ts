import { describe, expect, it } from "vitest";
import { resolveImagePickerMediaTypes } from "./image-picker-media-types";

describe("image picker media types", () => {
  it("offers images and videos on iOS", () => {
    expect(resolveImagePickerMediaTypes("ios")).toEqual(["images", "videos"]);
  });

  it("keeps other platforms image-only", () => {
    expect(resolveImagePickerMediaTypes("android")).toEqual(["images"]);
    expect(resolveImagePickerMediaTypes("web")).toEqual(["images"]);
  });
});
