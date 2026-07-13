import { describe, expect, it, vi } from "vitest";
import {
  AttachmentTooLargeError,
  base64Bytes,
  encodeAttachmentsToBudget,
  IMAGE_COMPRESS_TRIGGER_BASE64_CHARS,
  isCompressibleImage,
  MAX_TOTAL_ATTACHMENT_BASE64_CHARS,
  type BudgetAttachment,
  type EncodeBudgetDeps,
} from "./image-compression";

function att(id: string, mimeType = "image/png"): BudgetAttachment {
  return { id, mimeType };
}

function deps(overrides: Partial<EncodeBudgetDeps>): EncodeBudgetDeps {
  return {
    encodeBase64: async (id) => `${id}:base64`,
    resolvePreviewUrl: async (id) => `blob:${id}`,
    releasePreviewUrl: async () => {},
    compress: async () => null,
    ...overrides,
  };
}

describe("base64Bytes", () => {
  it("estimates decoded byte length", () => {
    expect(base64Bytes("")).toBe(0);
    expect(base64Bytes("AAAA")).toBe(3); // 4 chars, no padding
    expect(base64Bytes("AAA=")).toBe(2);
    expect(base64Bytes("AA==")).toBe(1);
  });

  it("ignores a data-url prefix", () => {
    expect(base64Bytes("data:image/jpeg;base64,AAAA")).toBe(3);
  });
});

describe("isCompressibleImage", () => {
  it("accepts jpeg/png/webp, rejects gif/svg/non-image", () => {
    expect(isCompressibleImage("image/png")).toBe(true);
    expect(isCompressibleImage("image/jpeg")).toBe(true);
    expect(isCompressibleImage("image/webp")).toBe(true);
    expect(isCompressibleImage("image/gif")).toBe(false);
    expect(isCompressibleImage("image/svg+xml")).toBe(false);
    expect(isCompressibleImage("application/pdf")).toBe(false);
  });
});

describe("encodeAttachmentsToBudget", () => {
  it("passes small attachments through without compressing", async () => {
    const compress = vi.fn(async () => null);
    const result = await encodeAttachmentsToBudget([att("a", "image/jpeg")], deps({ compress }));
    expect(result).toEqual([{ data: "a:base64", mimeType: "image/jpeg" }]);
    expect(compress).not.toHaveBeenCalled();
  });

  it("compresses attachments whose base64 exceeds the trigger", async () => {
    const big = "x".repeat(IMAGE_COMPRESS_TRIGGER_BASE64_CHARS + 10);
    const compress = vi.fn(async () => ({ data: "small", mimeType: "image/jpeg" }));
    const release = vi.fn(async () => {});

    const result = await encodeAttachmentsToBudget(
      [att("big", "image/png")],
      deps({ encodeBase64: async () => big, compress, releasePreviewUrl: release }),
    );

    expect(compress).toHaveBeenCalledWith({
      url: "blob:big",
      mimeType: "image/png",
      targetBytes: expect.any(Number),
    });
    expect(result).toEqual([{ data: "small", mimeType: "image/jpeg" }]);
    // preview url is released even on the success path
    expect(release).toHaveBeenCalledWith("big", "blob:big");
  });

  it("keeps the original when compression returns a larger result", async () => {
    const big = "x".repeat(IMAGE_COMPRESS_TRIGGER_BASE64_CHARS + 10);
    const result = await encodeAttachmentsToBudget(
      [att("big", "image/png")],
      deps({
        encodeBase64: async () => big,
        compress: async () => ({ data: "y".repeat(big.length + 100), mimeType: "image/jpeg" }),
      }),
    );
    expect(result[0].data).toBe(big);
  });

  it("does not compress non-compressible images (gif)", async () => {
    const big = "x".repeat(IMAGE_COMPRESS_TRIGGER_BASE64_CHARS + 10);
    const compress = vi.fn(async () => ({ data: "small", mimeType: "image/jpeg" }));
    // gif small enough to stay under total budget so it passes through untouched
    const small = "g".repeat(1000);
    void big;
    const result = await encodeAttachmentsToBudget(
      [att("g", "image/gif")],
      deps({ encodeBase64: async () => small, compress }),
    );
    expect(compress).not.toHaveBeenCalled();
    expect(result).toEqual([{ data: small, mimeType: "image/gif" }]);
  });

  it("throws AttachmentTooLargeError when still over budget after compression", async () => {
    const big = "x".repeat(MAX_TOTAL_ATTACHMENT_BASE64_CHARS + 100_000);
    await expect(
      encodeAttachmentsToBudget(
        [att("big", "image/png")],
        deps({
          encodeBase64: async () => big,
          // compressor shrinks the image but not below the total budget
          compress: async () => ({
            data: "z".repeat(MAX_TOTAL_ATTACHMENT_BASE64_CHARS + 1),
            mimeType: "image/jpeg",
          }),
        }),
      ),
    ).rejects.toBeInstanceOf(AttachmentTooLargeError);
  });

  it("throws when the sum of several attachments exceeds the budget", async () => {
    const half = "y".repeat(Math.ceil(MAX_TOTAL_ATTACHMENT_BASE64_CHARS * 0.6));
    await expect(
      encodeAttachmentsToBudget(
        [att("a", "image/gif"), att("b", "image/gif")],
        deps({ encodeBase64: async (id) => (id === "a" ? half : half) }),
      ),
    ).rejects.toBeInstanceOf(AttachmentTooLargeError);
  });

  it("skips attachments that fail to encode instead of throwing", async () => {
    const result = await encodeAttachmentsToBudget(
      [att("bad"), att("good", "image/jpeg")],
      deps({
        encodeBase64: async (id) => {
          if (id === "bad") throw new Error("boom");
          return `${id}:base64`;
        },
      }),
    );
    expect(result).toEqual([{ data: "good:base64", mimeType: "image/jpeg" }]);
  });
});
