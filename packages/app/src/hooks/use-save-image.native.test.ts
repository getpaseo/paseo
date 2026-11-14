/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import * as LegacyFileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { useSaveImage } from "./use-save-image.native";

vi.mock("expo-file-system/legacy", () => ({
  cacheDirectory: "file:///mock-cache/",
  documentDirectory: "file:///mock-docs/",
  downloadAsync: vi.fn(),
  writeAsStringAsync: vi.fn(),
  EncodingType: { Base64: "base64" },
}));

vi.mock("expo-sharing", () => ({
  isAvailableAsync: vi.fn(),
  shareAsync: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => (key === "message.attachments.downloadImage" ? "Download image" : key),
  }),
}));

describe("useSaveImage (native)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Sharing.isAvailableAsync).mockResolvedValue(true);
    vi.mocked(Sharing.shareAsync).mockResolvedValue(undefined);
  });

  it("shares local file:// URIs directly without downloading", async () => {
    const { result } = renderHook(() => useSaveImage());
    const localUri = "file:///data/user/0/com.paseo/cache/preview.png";

    await result.current(localUri);

    expect(LegacyFileSystem.downloadAsync).not.toHaveBeenCalled();
    expect(Sharing.shareAsync).toHaveBeenCalledWith(localUri, {
      dialogTitle: "Download image",
    });
  });

  it("shares content:// URIs directly without downloading", async () => {
    const { result } = renderHook(() => useSaveImage());
    const contentUri = "content://media/external/images/media/42";

    await result.current(contentUri);

    expect(LegacyFileSystem.downloadAsync).not.toHaveBeenCalled();
    expect(Sharing.shareAsync).toHaveBeenCalledWith(contentUri, {
      dialogTitle: "Download image",
    });
  });

  it("downloads remote http/https URIs to cache and then shares the downloaded file", async () => {
    vi.mocked(LegacyFileSystem.downloadAsync).mockResolvedValue({
      uri: "file:///mock-cache/photo.jpg",
      status: 200,
      headers: {},
      md5: "abc",
      mimeType: "image/jpeg",
    });

    const { result } = renderHook(() => useSaveImage());
    const remoteUrl = "https://example.com/assets/photo.jpg";

    await result.current(remoteUrl);

    expect(LegacyFileSystem.downloadAsync).toHaveBeenCalledWith(
      remoteUrl,
      "file:///mock-cache/photo.jpg",
    );
    expect(Sharing.shareAsync).toHaveBeenCalledWith("file:///mock-cache/photo.jpg", {
      dialogTitle: "Download image",
    });
  });

  it("saves base64 data URLs to cache and then shares them", async () => {
    const { result } = renderHook(() => useSaveImage());
    const dataUri = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

    await result.current(dataUri);

    expect(LegacyFileSystem.writeAsStringAsync).toHaveBeenCalledWith(
      expect.stringMatching(/^file:\/\/\/mock-cache\/image_\d+\.png$/),
      "iVBORw0KGgoAAAANSUhEUg==",
      { encoding: "base64" },
    );
    expect(Sharing.shareAsync).toHaveBeenCalledWith(
      expect.stringMatching(/^file:\/\/\/mock-cache\/image_\d+\.png$/),
      { dialogTitle: "Download image" },
    );
  });

  it("throws an error when sharing is unavailable on the device", async () => {
    vi.mocked(Sharing.isAvailableAsync).mockResolvedValue(false);

    const { result } = renderHook(() => useSaveImage());

    await expect(result.current("file:///some/image.png")).rejects.toThrow(
      "Sharing is not available on this device.",
    );
  });
});
