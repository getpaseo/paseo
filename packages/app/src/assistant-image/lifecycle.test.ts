import { describe, expect, it } from "vitest";
import { createAssistantImageLifecycle, transitionAssistantImageLifecycle } from "./lifecycle";

describe("assistant image lifecycle", () => {
  it("keeps preview URL recreation in the public loading state", () => {
    const loading = transitionAssistantImageLifecycle(createAssistantImageLifecycle(), {
      type: "preview_created",
      uri: "blob:first",
      aspectRatio: null,
    });
    const loaded = transitionAssistantImageLifecycle(loading, {
      type: "image_loaded",
      uri: "blob:first",
      aspectRatio: 1.5,
    });

    const recreating = transitionAssistantImageLifecycle(loaded, {
      type: "preview_released",
    });

    expect(recreating).toEqual({ status: "loading", uri: null, aspectRatio: null });
  });

  it("publishes loaded only after the recreated URL loads", () => {
    const recreating = transitionAssistantImageLifecycle(createAssistantImageLifecycle(), {
      type: "preview_created",
      uri: "blob:recreated",
      aspectRatio: 1.5,
    });

    expect(recreating).toEqual({
      status: "loading",
      uri: "blob:recreated",
      aspectRatio: 1.5,
    });

    const recreated = transitionAssistantImageLifecycle(recreating, {
      type: "image_loaded",
      uri: "blob:recreated",
      aspectRatio: 0.75,
    });

    expect(recreated).toEqual({
      status: "loaded",
      uri: "blob:recreated",
      aspectRatio: 0.75,
    });
  });

  it("publishes failed for a terminal image failure on the current URI", () => {
    const loading = transitionAssistantImageLifecycle(createAssistantImageLifecycle(), {
      type: "preview_created",
      uri: "blob:current",
      aspectRatio: null,
    });
    const failed = transitionAssistantImageLifecycle(loading, {
      type: "failed",
      uri: "blob:current",
      message: "Unable to load image preview.",
    });

    expect(failed).toEqual({
      status: "failed",
      message: "Unable to load image preview.",
    });
  });

  it("ignores a stale load callback from a replaced URI", () => {
    const current = transitionAssistantImageLifecycle(createAssistantImageLifecycle(), {
      type: "preview_created",
      uri: "blob:current",
      aspectRatio: 1.25,
    });

    const afterStaleLoad = transitionAssistantImageLifecycle(current, {
      type: "image_loaded",
      uri: "blob:released",
      aspectRatio: 2,
    });

    expect(afterStaleLoad).toEqual(current);
  });

  it("ignores a stale error callback from a replaced URI", () => {
    const current = transitionAssistantImageLifecycle(createAssistantImageLifecycle(), {
      type: "preview_created",
      uri: "blob:current",
      aspectRatio: null,
    });

    const afterStaleError = transitionAssistantImageLifecycle(current, {
      type: "failed",
      uri: "blob:released",
      message: "Image unavailable",
    });

    expect(afterStaleError).toEqual(current);
  });
});
