/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useSaveImage } from "./use-save-image.web";

describe("useSaveImage (web)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, "open").mockImplementation(() => null);
    if (!URL.createObjectURL) {
      URL.createObjectURL = vi.fn(() => "blob:http://localhost:3000/mock-blob");
    } else {
      vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:http://localhost:3000/mock-blob");
    }
    if (!URL.revokeObjectURL) {
      URL.revokeObjectURL = vi.fn();
    } else {
      vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    }
  });

  it("downloads blob URLs directly using an anchor element", async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const { result } = renderHook(() => useSaveImage());
    await result.current("blob:http://localhost:3000/preview-123");

    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  it("falls back to window.open in a new tab when fetch fails to avoid leaving the app", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("CORS error")));

    const { result } = renderHook(() => useSaveImage());
    await result.current("https://external-cdn.com/image.png");

    expect(window.open).toHaveBeenCalledWith(
      "https://external-cdn.com/image.png",
      "_blank",
      "noopener,noreferrer",
    );
  });
});
