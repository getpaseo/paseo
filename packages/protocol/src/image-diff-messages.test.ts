import { describe, expect, it } from "vitest";
import {
  CheckoutDiffGetImageRequestSchema,
  CheckoutDiffGetImageResponseSchema,
  SubscribeCheckoutDiffResponseSchema,
  parseServerInfoStatusPayload,
} from "./messages";

describe("image diff protocol", () => {
  it("accepts optional image metadata on parsed diff files", () => {
    const parsed = SubscribeCheckoutDiffResponseSchema.parse({
      type: "subscribe_checkout_diff_response",
      payload: {
        subscriptionId: "sub-1",
        cwd: "/repo",
        files: [
          {
            path: "snapshots/home.png",
            isNew: false,
            isDeleted: false,
            additions: 0,
            deletions: 0,
            hunks: [],
            status: "binary",
            binaryKind: "image",
          },
        ],
        error: null,
        requestId: "req-1",
      },
    });

    expect(parsed.payload.files[0]).toMatchObject({
      status: "binary",
      binaryKind: "image",
    });
  });

  it("accepts optional oldPath on parsed image files and image requests", () => {
    const parsedDiff = SubscribeCheckoutDiffResponseSchema.parse({
      type: "subscribe_checkout_diff_response",
      payload: {
        subscriptionId: "sub-1",
        cwd: "/repo",
        files: [
          {
            path: "after.png",
            oldPath: "before.png",
            isNew: false,
            isDeleted: false,
            additions: 0,
            deletions: 0,
            hunks: [],
            status: "binary",
            binaryKind: "image",
          },
        ],
        error: null,
        requestId: "req-1",
      },
    });

    expect(parsedDiff.payload.files[0]).toMatchObject({
      path: "after.png",
      oldPath: "before.png",
    });

    const request = CheckoutDiffGetImageRequestSchema.parse({
      type: "checkout.diff.get_image.request",
      cwd: "/repo",
      path: "after.png",
      oldPath: "before.png",
      compare: { mode: "uncommitted" },
      requestId: "req-image",
    });

    expect(request).toMatchObject({ path: "after.png", oldPath: "before.png" });
  });

  it("parses image diff request and response", () => {
    expect(
      CheckoutDiffGetImageRequestSchema.parse({
        type: "checkout.diff.get_image.request",
        cwd: "/repo",
        path: "snapshots/home.png",
        compare: { mode: "base", baseRef: "main" },
        requestId: "req-image",
      }),
    ).toMatchObject({ path: "snapshots/home.png" });

    expect(
      CheckoutDiffGetImageResponseSchema.parse({
        type: "checkout.diff.get_image.response",
        payload: {
          cwd: "/repo",
          path: "snapshots/home.png",
          oldImage: {
            status: "available",
            mimeType: "image/png",
            encoding: "base64",
            content: "aGVsbG8=",
            size: 5,
            width: 1,
            height: 1,
          },
          newImage: { status: "missing" },
          diffImage: { status: "missing" },
          error: null,
          requestId: "req-image",
        },
      }),
    ).toMatchObject({
      payload: {
        oldImage: { status: "available", encoding: "base64" },
        newImage: { status: "missing" },
      },
    });
  });

  it("parses too_large generated image diff responses", () => {
    expect(
      CheckoutDiffGetImageResponseSchema.parse({
        type: "checkout.diff.get_image.response",
        payload: {
          cwd: "/repo",
          path: "snapshots/home.png",
          oldImage: { status: "missing" },
          newImage: { status: "missing" },
          diffImage: { status: "too_large", size: 16_777_216, maxSize: 8_388_608 },
          error: null,
          requestId: "req-image",
        },
      }),
    ).toMatchObject({
      payload: {
        diffImage: { status: "too_large", size: 16_777_216, maxSize: 8_388_608 },
      },
    });
  });

  it("keeps image diff feature optional on server info", () => {
    expect(
      parseServerInfoStatusPayload({
        status: "server_info",
        serverId: "srv",
        features: { imageDiffs: true },
      }),
    ).toMatchObject({ features: { imageDiffs: true } });
  });
});
