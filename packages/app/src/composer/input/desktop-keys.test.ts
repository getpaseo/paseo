import { describe, expect, it, vi } from "vitest";
import { handleDesktopKeyPressImpl, type DesktopKeyPressContext } from "./desktop-keys";

function keyEvent(key: string, modifiers: Record<string, boolean> = {}) {
  const preventDefault = vi.fn();
  return {
    event: { nativeEvent: { key, ...modifiers }, preventDefault },
    preventDefault,
  };
}

function ghost() {
  return {
    text: "run the failing test",
    accept: vi.fn(),
    submit: vi.fn(),
    dismiss: vi.fn(),
  };
}

function context(
  overrides: Partial<DesktopKeyPressContext<string, { text: string }>> = {},
): DesktopKeyPressContext<string, { text: string }> {
  return {
    ghostSuggestion: null,
    onKeyPressCallback: undefined,
    input: "",
    submitOnEnter: true,
    isAgentRunning: false,
    onQueue: undefined,
    isSubmitDisabled: false,
    isSubmitLoading: false,
    disabled: false,
    handleAlternateSendAction: vi.fn(),
    handleDefaultSendAction: vi.fn(),
    ...overrides,
  };
}

describe("handleDesktopKeyPressImpl with a ghost suggestion", () => {
  it("accepts on Tab", () => {
    const suggestion = ghost();
    const { event, preventDefault } = keyEvent("Tab");

    handleDesktopKeyPressImpl(event, context({ ghostSuggestion: suggestion }));

    expect(suggestion.accept).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("sends on Enter and dismisses on Escape", () => {
    const suggestion = ghost();
    const ctx = context({ ghostSuggestion: suggestion });

    handleDesktopKeyPressImpl(keyEvent("Enter").event, ctx);
    handleDesktopKeyPressImpl(keyEvent("Escape").event, ctx);

    expect(suggestion.submit).toHaveBeenCalledOnce();
    expect(suggestion.dismiss).toHaveBeenCalledOnce();
    expect(ctx.handleDefaultSendAction).not.toHaveBeenCalled();
  });

  it("leaves Tab to the autocomplete when it handles the key", () => {
    const suggestion = ghost();
    const onKeyPressCallback = vi.fn().mockReturnValue(true);

    handleDesktopKeyPressImpl(
      keyEvent("Tab").event,
      context({ ghostSuggestion: suggestion, onKeyPressCallback }),
    );

    expect(onKeyPressCallback).toHaveBeenCalledOnce();
    expect(suggestion.accept).not.toHaveBeenCalled();
  });

  it("ignores modified keys so Shift+Enter and Cmd+Enter keep their meaning", () => {
    const suggestion = ghost();
    const onQueue = vi.fn();
    const ctx = context({
      ghostSuggestion: suggestion,
      isAgentRunning: true,
      onQueue,
    });

    handleDesktopKeyPressImpl(keyEvent("Enter", { shiftKey: true }).event, ctx);
    handleDesktopKeyPressImpl(keyEvent("Enter", { metaKey: true }).event, ctx);

    expect(suggestion.submit).not.toHaveBeenCalled();
    expect(ctx.handleAlternateSendAction).toHaveBeenCalledOnce();
  });

  it("ignores the ghost during IME composition", () => {
    const suggestion = ghost();

    handleDesktopKeyPressImpl(
      keyEvent("Enter", { isComposing: true }).event,
      context({ ghostSuggestion: suggestion }),
    );

    expect(suggestion.submit).not.toHaveBeenCalled();
  });

  it("refuses ghost Enter while an attachment is still uploading", () => {
    const suggestion = ghost();
    const ctx = context({ ghostSuggestion: suggestion, isSubmitDisabled: true });
    const { event, preventDefault } = keyEvent("Enter");

    handleDesktopKeyPressImpl(event, ctx);

    expect(suggestion.submit).not.toHaveBeenCalled();
    expect(ctx.handleDefaultSendAction).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("still accepts and dismisses the ghost while sending is blocked", () => {
    const suggestion = ghost();
    const ctx = context({ ghostSuggestion: suggestion, isSubmitLoading: true });

    handleDesktopKeyPressImpl(keyEvent("Tab").event, ctx);
    handleDesktopKeyPressImpl(keyEvent("Escape").event, ctx);

    expect(suggestion.accept).toHaveBeenCalledOnce();
    expect(suggestion.dismiss).toHaveBeenCalledOnce();
  });

  it("keeps ordinary Enter submission when there is no ghost", () => {
    const ctx = context();

    handleDesktopKeyPressImpl(keyEvent("Enter").event, ctx);

    expect(ctx.handleDefaultSendAction).toHaveBeenCalledOnce();
  });
});
