import { describe, expect, it, vi } from "vitest";
import { submitAgentInput } from "./agent-input-submit";

function createDeferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return {
    promise,
    resolve,
    reject,
  };
}

describe("submitAgentInput", () => {
  it("clears the composer before an in-flight submit resolves", async () => {
    const deferred = createDeferredPromise<void>();
    const queueMessage = vi.fn();
    const submitMessage = vi.fn(async () => {
      await deferred.promise;
    });
    const clearDraft = vi.fn();
    const setUserInput = vi.fn();
    const setSelectedImages = vi.fn();
    const setSendError = vi.fn();
    const setIsProcessing = vi.fn();

    const submitPromise = submitAgentInput({
      message: "  hello world  ",
      isAgentRunning: false,
      canSubmit: true,
      queueMessage,
      submitMessage,
      clearDraft,
      setUserInput,
      setSelectedImages,
      setSendError,
      setIsProcessing,
    });

    expect(queueMessage).not.toHaveBeenCalled();
    expect(submitMessage).toHaveBeenCalledWith({
      message: "hello world",
      imageAttachments: undefined,
    });
    expect(setUserInput).toHaveBeenCalledWith("");
    expect(setSelectedImages).toHaveBeenCalledWith([]);
    expect(setSendError).toHaveBeenCalledWith(null);
    expect(setIsProcessing).toHaveBeenCalledWith(true);
    expect(clearDraft).not.toHaveBeenCalled();

    deferred.resolve();

    await expect(submitPromise).resolves.toBe("submitted");
    expect(clearDraft).toHaveBeenCalledWith("sent");
  });

  it("queues while the agent is running and clears the composer immediately", async () => {
    const queueMessage = vi.fn();
    const submitMessage = vi.fn();
    const clearDraft = vi.fn();
    const setUserInput = vi.fn();
    const setSelectedImages = vi.fn();
    const setSendError = vi.fn();
    const setIsProcessing = vi.fn();

    await expect(
      submitAgentInput({
        message: "  queued message  ",
        imageAttachments: [{ id: "img-1" }],
        isAgentRunning: true,
        canSubmit: true,
        queueMessage,
        submitMessage,
        clearDraft,
        setUserInput,
        setSelectedImages,
        setSendError,
        setIsProcessing,
      }),
    ).resolves.toBe("queued");

    expect(queueMessage).toHaveBeenCalledWith({
      message: "queued message",
      imageAttachments: [{ id: "img-1" }],
    });
    expect(submitMessage).not.toHaveBeenCalled();
    expect(setUserInput).toHaveBeenCalledWith("");
    expect(setSelectedImages).toHaveBeenCalledWith([]);
    expect(setSendError).not.toHaveBeenCalled();
    expect(setIsProcessing).not.toHaveBeenCalled();
    expect(clearDraft).not.toHaveBeenCalled();
  });

  it("restores the composer when submit fails", async () => {
    const submitError = new Error("No host selected");
    const queueMessage = vi.fn();
    const submitMessage = vi.fn(async () => {
      throw submitError;
    });
    const clearDraft = vi.fn();
    const setUserInput = vi.fn();
    const setSelectedImages = vi.fn();
    const setSendError = vi.fn();
    const setIsProcessing = vi.fn();
    const onSubmitError = vi.fn();
    const imageAttachments = [{ id: "img-1" }];

    await expect(
      submitAgentInput({
        message: "  hello world  ",
        imageAttachments,
        isAgentRunning: false,
        canSubmit: true,
        queueMessage,
        submitMessage,
        clearDraft,
        setUserInput,
        setSelectedImages,
        setSendError,
        setIsProcessing,
        onSubmitError,
      }),
    ).resolves.toBe("failed");

    expect(onSubmitError).toHaveBeenCalledWith(submitError);
    expect(setUserInput).toHaveBeenNthCalledWith(1, "");
    expect(setUserInput).toHaveBeenNthCalledWith(2, "hello world");
    expect(setSelectedImages).toHaveBeenNthCalledWith(1, []);
    expect(setSelectedImages).toHaveBeenNthCalledWith(2, imageAttachments);
    expect(setSendError).toHaveBeenNthCalledWith(1, null);
    expect(setSendError).toHaveBeenNthCalledWith(2, "No host selected");
    expect(setIsProcessing).toHaveBeenNthCalledWith(1, true);
    expect(setIsProcessing).toHaveBeenNthCalledWith(2, false);
    expect(clearDraft).not.toHaveBeenCalled();
  });
});
