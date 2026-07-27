import { describe, expect, it, vi } from "vitest";
import {
  handleComposerBeforeInput,
  handleComposerKeyPress,
  shouldSubmitComposerFromNativeReturn,
  type ComposerKeyPressContext,
} from "./key-press";

describe("handleComposerBeforeInput", () => {
  it.each(["insertLineBreak", "insertParagraph"])(
    "sends mobile web %s input in send mode",
    (inputType) => {
      const event = { inputType, preventDefault: vi.fn() };
      const handleDefaultSendAction = vi.fn();

      handleComposerBeforeInput(event, {
        submitOnEnter: true,
        isSubmitBlocked: false,
        handleDefaultSendAction,
      });

      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(handleDefaultSendAction).toHaveBeenCalledOnce();
    },
  );

  it("preserves line breaks when Enter is configured for newlines", () => {
    const event = { inputType: "insertLineBreak", preventDefault: vi.fn() };
    const handleDefaultSendAction = vi.fn();

    handleComposerBeforeInput(event, {
      submitOnEnter: false,
      isSubmitBlocked: false,
      handleDefaultSendAction,
    });

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(handleDefaultSendAction).not.toHaveBeenCalled();
  });

  it("does not intercept input while an IME is composing", () => {
    const event = { inputType: "insertLineBreak", isComposing: true, preventDefault: vi.fn() };
    const handleDefaultSendAction = vi.fn();

    handleComposerBeforeInput(event, {
      submitOnEnter: true,
      isSubmitBlocked: false,
      handleDefaultSendAction,
    });

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(handleDefaultSendAction).not.toHaveBeenCalled();
  });

  it("blocks newline insertion without submitting when send is unavailable", () => {
    const event = { inputType: "insertParagraph", preventDefault: vi.fn() };
    const handleDefaultSendAction = vi.fn();

    handleComposerBeforeInput(event, {
      submitOnEnter: true,
      isSubmitBlocked: true,
      handleDefaultSendAction,
    });

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(handleDefaultSendAction).not.toHaveBeenCalled();
  });
});

function createContext(overrides: Partial<ComposerKeyPressContext> = {}): ComposerKeyPressContext {
  return {
    onKeyPressCallback: undefined,
    submitOnEnter: true,
    submitOnModEnter: false,
    useAlternateSendAction: false,
    isSubmitBlocked: false,
    handleAlternateSendAction: vi.fn(),
    handleDefaultSendAction: vi.fn(),
    ...overrides,
  };
}

function createEvent(overrides: Partial<Parameters<typeof handleComposerKeyPress>[0]> = {}) {
  return {
    key: "Enter",
    preventDefault: vi.fn(),
    ...overrides,
  };
}

describe("handleComposerKeyPress", () => {
  it("sends on plain Enter when Enter is configured to send", () => {
    const event = createEvent();
    const context = createContext();

    handleComposerKeyPress(event, context);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(context.handleDefaultSendAction).toHaveBeenCalledOnce();
  });

  it("keeps plain Enter as a newline when newline is configured", () => {
    const event = createEvent();
    const context = createContext({ submitOnEnter: false, submitOnModEnter: true });

    handleComposerKeyPress(event, context);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(context.handleDefaultSendAction).not.toHaveBeenCalled();
  });

  it("sends with Command or Control plus Enter when newline is configured", () => {
    const event = createEvent({ metaKey: true });
    const context = createContext({
      submitOnEnter: false,
      submitOnModEnter: true,
      useAlternateSendAction: true,
    });

    handleComposerKeyPress(event, context);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(context.handleDefaultSendAction).toHaveBeenCalledOnce();
    expect(context.handleAlternateSendAction).not.toHaveBeenCalled();
  });

  it("uses the alternate action for modified Enter in send mode", () => {
    const event = createEvent({ ctrlKey: true });
    const context = createContext({ useAlternateSendAction: true });

    handleComposerKeyPress(event, context);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(context.handleAlternateSendAction).toHaveBeenCalledOnce();
    expect(context.handleDefaultSendAction).not.toHaveBeenCalled();
  });

  it("blocks newline insertion when send mode cannot submit", () => {
    const event = createEvent();
    const context = createContext({ isSubmitBlocked: true });

    handleComposerKeyPress(event, context);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(context.handleDefaultSendAction).not.toHaveBeenCalled();
  });

  it("always leaves Shift plus Enter as a newline", () => {
    const event = createEvent({ shiftKey: true });
    const context = createContext();

    handleComposerKeyPress(event, context);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(context.handleDefaultSendAction).not.toHaveBeenCalled();
  });

  it("does not submit while an input method editor is composing", () => {
    const event = createEvent({ isComposing: true });
    const context = createContext();

    handleComposerKeyPress(event, context);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(context.handleDefaultSendAction).not.toHaveBeenCalled();
  });
});

describe("shouldSubmitComposerFromNativeReturn", () => {
  it("submits a mobile software-keyboard return in send mode", () => {
    expect(
      shouldSubmitComposerFromNativeReturn({ enterKeyBehavior: "send", isSubmitBlocked: false }),
    ).toBe(true);
  });

  it("preserves return as a newline in newline mode", () => {
    expect(
      shouldSubmitComposerFromNativeReturn({
        enterKeyBehavior: "newline",
        isSubmitBlocked: false,
      }),
    ).toBe(false);
  });

  it("does not submit when sending is blocked", () => {
    expect(
      shouldSubmitComposerFromNativeReturn({ enterKeyBehavior: "send", isSubmitBlocked: true }),
    ).toBe(false);
  });
});
