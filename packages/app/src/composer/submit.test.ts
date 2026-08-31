import { describe, expect, it, vi } from "vitest";
import { submitAgentInput } from "./submit";

function createDeferredPromise<T>(): PromiseWithResolvers<T> {
  return Promise.withResolvers<T>();
}

describe("submitAgentInput", () => {
  it("starts a draft attempt before an in-flight submit resolves", async () => {
    const deferred = createDeferredPromise<void>();
    const queueMessage = vi.fn();
    const submitMessage = vi.fn(async () => {
      await deferred.promise;
    });
    const beginDraftAttempt = vi.fn(() => 1);
    const settleDraftAttempt = vi.fn();
    const setSendError = vi.fn();
    const setIsProcessing = vi.fn();

    const submitPromise = submitAgentInput({
      message: "  hello world  ",
      attachments: [],
      isAgentRunning: false,
      canSubmit: true,
      queueMessage,
      submitMessage,
      beginDraftAttempt,
      settleDraftAttempt,
      setSendError,
      setIsProcessing,
    });

    expect(queueMessage).not.toHaveBeenCalled();
    expect(submitMessage).toHaveBeenCalledWith({
      message: "hello world",
      attachments: [],
    });
    expect(beginDraftAttempt).toHaveBeenCalledWith({ message: "hello world", attachments: [] });
    expect(setSendError).toHaveBeenCalledWith(null);
    expect(setIsProcessing).toHaveBeenCalledWith(true);

    deferred.resolve();

    await expect(submitPromise).resolves.toBe("submitted");
    expect(settleDraftAttempt).toHaveBeenCalledWith({ attemptId: 1, outcome: "accepted" });
  });

  it("does not start a draft attempt for preserve-and-lock submits", async () => {
    const deferred = createDeferredPromise<void>();
    const attachments = [{ id: "img-1" }];
    const queueMessage = vi.fn();
    const submitMessage = vi.fn(async () => {
      await deferred.promise;
    });
    const beginDraftAttempt = vi.fn(() => 1);
    const settleDraftAttempt = vi.fn();
    const setSendError = vi.fn();
    const setIsProcessing = vi.fn();

    const submitPromise = submitAgentInput({
      message: "  keep me  ",
      attachments,
      submitBehavior: "preserve-and-lock",
      isAgentRunning: false,
      canSubmit: true,
      queueMessage,
      submitMessage,
      beginDraftAttempt,
      settleDraftAttempt,
      setSendError,
      setIsProcessing,
    });

    expect(queueMessage).not.toHaveBeenCalled();
    expect(submitMessage).toHaveBeenCalledWith({
      message: "keep me",
      attachments,
    });
    expect(beginDraftAttempt).not.toHaveBeenCalled();
    expect(settleDraftAttempt).not.toHaveBeenCalled();
    expect(setSendError).toHaveBeenCalledWith(null);
    expect(setIsProcessing).toHaveBeenCalledWith(true);

    deferred.resolve();

    await expect(submitPromise).resolves.toBe("submitted");
  });

  it("queues while the agent is running and leaves clearing to queueMessage", async () => {
    const queueMessage = vi.fn();
    const submitMessage = vi.fn();
    const beginDraftAttempt = vi.fn(() => 1);
    const settleDraftAttempt = vi.fn();
    const setSendError = vi.fn();
    const setIsProcessing = vi.fn();

    await expect(
      submitAgentInput({
        message: "  queued message  ",
        attachments: [{ id: "img-1" }],
        isAgentRunning: true,
        canSubmit: true,
        queueMessage,
        submitMessage,
        beginDraftAttempt,
        settleDraftAttempt,
        setSendError,
        setIsProcessing,
      }),
    ).resolves.toBe("queued");

    expect(queueMessage).toHaveBeenCalledWith({
      message: "queued message",
      attachments: [{ id: "img-1" }],
    });
    expect(submitMessage).not.toHaveBeenCalled();
    expect(beginDraftAttempt).not.toHaveBeenCalled();
    expect(settleDraftAttempt).not.toHaveBeenCalled();
    expect(setSendError).not.toHaveBeenCalled();
    expect(setIsProcessing).not.toHaveBeenCalled();
  });

  it("restores the composer when submit fails", async () => {
    const submitError = new Error("No host selected");
    const queueMessage = vi.fn();
    const submitMessage = vi.fn(async () => {
      throw submitError;
    });
    const beginDraftAttempt = vi.fn(() => 7);
    const settleDraftAttempt = vi.fn();
    const setSendError = vi.fn();
    const setIsProcessing = vi.fn();
    const onSubmitError = vi.fn();
    const attachments = [{ id: "img-1" }];

    await expect(
      submitAgentInput({
        message: "  hello world  ",
        attachments,
        isAgentRunning: false,
        canSubmit: true,
        queueMessage,
        submitMessage,
        beginDraftAttempt,
        settleDraftAttempt,
        setSendError,
        setIsProcessing,
        onSubmitError,
      }),
    ).resolves.toBe("failed");

    expect(onSubmitError).toHaveBeenCalledWith(submitError);
    expect(beginDraftAttempt).toHaveBeenCalledWith({
      message: "hello world",
      attachments,
    });
    expect(settleDraftAttempt).toHaveBeenCalledWith({ attemptId: 7, outcome: "failed" });
    expect(setSendError).toHaveBeenNthCalledWith(1, null);
    expect(setSendError).toHaveBeenNthCalledWith(2, "No host selected");
    expect(setIsProcessing).toHaveBeenNthCalledWith(1, true);
    expect(setIsProcessing).toHaveBeenNthCalledWith(2, false);
  });

  it("does not submit a duplicate draft attempt while one is pending", async () => {
    const queueMessage = vi.fn();
    const submitMessage = vi.fn(async () => {});
    const beginDraftAttempt = vi.fn(() => null);
    const settleDraftAttempt = vi.fn();
    const setSendError = vi.fn();
    const setIsProcessing = vi.fn();

    await expect(
      submitAgentInput({
        message: "duplicate",
        attachments: [],
        isAgentRunning: false,
        canSubmit: true,
        queueMessage,
        submitMessage,
        beginDraftAttempt,
        settleDraftAttempt,
        setSendError,
        setIsProcessing,
      }),
    ).resolves.toBe("noop");

    expect(submitMessage).not.toHaveBeenCalled();
    expect(settleDraftAttempt).not.toHaveBeenCalled();
    expect(setIsProcessing).not.toHaveBeenCalled();
  });

  it("restores a steered active-turn draft after an ambiguous immediate-send error", async () => {
    const error = new Error("connection lost after delivery");
    const attachments = [{ id: "img-1" }];
    const queueMessage = vi.fn();
    const submitMessage = vi.fn(async () => {
      throw error;
    });
    const beginDraftAttempt = vi.fn(() => 9);
    const settleDraftAttempt = vi.fn();
    const setSendError = vi.fn();
    const setIsProcessing = vi.fn();

    await expect(
      submitAgentInput({
        message: "  steer this turn  ",
        attachments,
        forceSend: true,
        isAgentRunning: true,
        canSubmit: true,
        queueMessage,
        submitMessage,
        beginDraftAttempt,
        settleDraftAttempt,
        setSendError,
        setIsProcessing,
      }),
    ).resolves.toBe("failed");

    expect(queueMessage).not.toHaveBeenCalled();
    expect(submitMessage).toHaveBeenCalledWith({ message: "steer this turn", attachments });
    expect(beginDraftAttempt).toHaveBeenCalledWith({ message: "steer this turn", attachments });
    expect(settleDraftAttempt).toHaveBeenCalledWith({ attemptId: 9, outcome: "failed" });
    expect(setSendError).toHaveBeenLastCalledWith("connection lost after delivery");
  });

  it("submits when empty submit is explicitly allowed", async () => {
    const queueMessage = vi.fn();
    const submitMessage = vi.fn(async () => {});
    const beginDraftAttempt = vi.fn(() => 1);
    const settleDraftAttempt = vi.fn();
    const setSendError = vi.fn();
    const setIsProcessing = vi.fn();

    await expect(
      submitAgentInput({
        message: "   ",
        attachments: [],
        allowEmptySubmit: true,
        isAgentRunning: false,
        canSubmit: true,
        queueMessage,
        submitMessage,
        beginDraftAttempt,
        settleDraftAttempt,
        setSendError,
        setIsProcessing,
      }),
    ).resolves.toBe("submitted");

    expect(queueMessage).not.toHaveBeenCalled();
    expect(submitMessage).toHaveBeenCalledWith({
      message: "",
      attachments: [],
    });
  });
});
