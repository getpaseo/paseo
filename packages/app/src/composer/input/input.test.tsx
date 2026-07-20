import { describe, expect, it, vi } from "vitest";
import { handleDesktopKeyPressImpl, insertNewlineAtSelection } from "./keyboard";
import type { WebTextInputKeyPressEvent } from "./keyboard";
import type { MessagePayload } from "@/composer/types";

function makeEvent(options: {
  key?: string;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}): WebTextInputKeyPressEvent {
  return {
    nativeEvent: {
      key: options.key ?? "Enter",
      shiftKey: options.shiftKey ?? false,
      altKey: options.altKey ?? false,
      metaKey: options.metaKey ?? false,
      ctrlKey: options.ctrlKey ?? false,
      isComposing: options.isComposing,
      keyCode: options.keyCode,
    },
    preventDefault: vi.fn(),
  } as unknown as WebTextInputKeyPressEvent;
}

function makeContext(overrides?: {
  value?: string;
  selection?: { start: number; end: number };
  submitOnEnter?: boolean;
  isSubmitDisabled?: boolean;
  isSubmitLoading?: boolean;
  disabled?: boolean;
  isAgentRunning?: boolean;
  onQueue?: ((payload: MessagePayload) => void) | undefined;
  onKeyPressCallback?:
    | ((event: { key: string; preventDefault: () => void }) => boolean)
    | undefined;
}) {
  const value = overrides?.value ?? "hello world";
  const selection = overrides?.selection ?? { start: value.length, end: value.length };
  const onChangeText = vi.fn();
  const onSelectionChange = vi.fn();
  const handleDefaultSendAction = vi.fn();
  const handleAlternateSendAction = vi.fn();

  return {
    value,
    selection,
    onChangeText,
    onSelectionChange,
    handleDefaultSendAction,
    handleAlternateSendAction,
    ctx: {
      onKeyPressCallback: overrides?.onKeyPressCallback,
      submitOnEnter: overrides?.submitOnEnter ?? true,
      isAgentRunning: overrides?.isAgentRunning ?? false,
      onQueue: overrides?.onQueue,
      isSubmitDisabled: overrides?.isSubmitDisabled ?? false,
      isSubmitLoading: overrides?.isSubmitLoading ?? false,
      disabled: overrides?.disabled ?? false,
      value,
      selection,
      onChangeText,
      onSelectionChange,
      handleAlternateSendAction,
      handleDefaultSendAction,
    },
  };
}

describe("insertNewlineAtSelection", () => {
  it("inserts a newline at the end by default", () => {
    const result = insertNewlineAtSelection("hello", { start: 5, end: 5 });
    expect(result.nextValue).toBe("hello\n");
    expect(result.nextSelection).toEqual({ start: 6, end: 6 });
  });

  it("inserts a newline in the middle", () => {
    const result = insertNewlineAtSelection("hello world", { start: 5, end: 5 });
    expect(result.nextValue).toBe("hello\n world");
    expect(result.nextSelection).toEqual({ start: 6, end: 6 });
  });

  it("inserts a newline at the start", () => {
    const result = insertNewlineAtSelection("hello", { start: 0, end: 0 });
    expect(result.nextValue).toBe("\nhello");
    expect(result.nextSelection).toEqual({ start: 1, end: 1 });
  });

  it("replaces the selected range with a newline", () => {
    const result = insertNewlineAtSelection("hello world", { start: 2, end: 8 });
    expect(result.nextValue).toBe("he\nrld");
    expect(result.nextSelection).toEqual({ start: 3, end: 3 });
  });
});

describe("handleDesktopKeyPressImpl newline insertion", () => {
  it("inserts a newline on Shift+Enter and prevents default", () => {
    const { ctx, onChangeText, onSelectionChange } = makeContext();
    const event = makeEvent({ shiftKey: true });
    handleDesktopKeyPressImpl(event, ctx);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(onChangeText).toHaveBeenCalledWith("hello world\n");
    expect(onSelectionChange).toHaveBeenCalledWith({ start: 12, end: 12 });
    expect(ctx.handleDefaultSendAction).not.toHaveBeenCalled();
    expect(ctx.handleAlternateSendAction).not.toHaveBeenCalled();
  });

  it("inserts a newline on Alt+Enter and prevents default", () => {
    const { ctx, onChangeText, onSelectionChange } = makeContext();
    const event = makeEvent({ altKey: true });
    handleDesktopKeyPressImpl(event, ctx);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(onChangeText).toHaveBeenCalledWith("hello world\n");
    expect(onSelectionChange).toHaveBeenCalledWith({ start: 12, end: 12 });
    expect(ctx.handleDefaultSendAction).not.toHaveBeenCalled();
    expect(ctx.handleAlternateSendAction).not.toHaveBeenCalled();
  });

  it("inserts a newline in the middle of text", () => {
    const { ctx, onChangeText, onSelectionChange } = makeContext({
      value: "hello world",
      selection: { start: 5, end: 5 },
    });
    const event = makeEvent({ altKey: true });
    handleDesktopKeyPressImpl(event, ctx);
    expect(onChangeText).toHaveBeenCalledWith("hello\n world");
    expect(onSelectionChange).toHaveBeenCalledWith({ start: 6, end: 6 });
  });

  it("replaces the selected text with a newline", () => {
    const { ctx, onChangeText, onSelectionChange } = makeContext({
      value: "hello world",
      selection: { start: 2, end: 8 },
    });
    const event = makeEvent({ shiftKey: true });
    handleDesktopKeyPressImpl(event, ctx);
    expect(onChangeText).toHaveBeenCalledWith("he\nrld");
    expect(onSelectionChange).toHaveBeenCalledWith({ start: 3, end: 3 });
  });

  it("still inserts a newline when submitOnEnter is false", () => {
    const { ctx, onChangeText } = makeContext({ submitOnEnter: false });
    const event = makeEvent({ shiftKey: true });
    handleDesktopKeyPressImpl(event, ctx);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(onChangeText).toHaveBeenCalledWith("hello world\n");
    expect(ctx.handleDefaultSendAction).not.toHaveBeenCalled();
  });
});

describe("handleDesktopKeyPressImpl send behavior", () => {
  it("submits on plain Enter", () => {
    const { ctx } = makeContext();
    const event = makeEvent({});
    handleDesktopKeyPressImpl(event, ctx);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(ctx.handleDefaultSendAction).toHaveBeenCalled();
  });

  it("does not submit when submitOnEnter is false", () => {
    const { ctx } = makeContext({ submitOnEnter: false });
    const event = makeEvent({});
    handleDesktopKeyPressImpl(event, ctx);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(ctx.handleDefaultSendAction).not.toHaveBeenCalled();
  });

  it("queues on Mod+Enter when agent is running and queue is available", () => {
    const onQueue = vi.fn();
    const { ctx } = makeContext({
      isAgentRunning: true,
      onQueue,
    });
    const event = makeEvent({ metaKey: true });
    handleDesktopKeyPressImpl(event, ctx);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(ctx.handleAlternateSendAction).toHaveBeenCalled();
    expect(ctx.handleDefaultSendAction).not.toHaveBeenCalled();
  });

  it("does not submit when disabled", () => {
    const { ctx } = makeContext({ disabled: true });
    const event = makeEvent({});
    handleDesktopKeyPressImpl(event, ctx);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(ctx.handleDefaultSendAction).not.toHaveBeenCalled();
  });

  it("does not submit when loading", () => {
    const { ctx } = makeContext({ isSubmitLoading: true });
    const event = makeEvent({});
    handleDesktopKeyPressImpl(event, ctx);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(ctx.handleDefaultSendAction).not.toHaveBeenCalled();
  });
});

describe("handleDesktopKeyPressImpl IME and interception", () => {
  it("does nothing during IME composition", () => {
    const { ctx, onChangeText, handleDefaultSendAction } = makeContext();
    const event = makeEvent({ isComposing: true });
    handleDesktopKeyPressImpl(event, ctx);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(onChangeText).not.toHaveBeenCalled();
    expect(handleDefaultSendAction).not.toHaveBeenCalled();
  });

  it("does nothing when keyCode is 229 (legacy IME)", () => {
    const { ctx, onChangeText, handleDefaultSendAction } = makeContext();
    const event = makeEvent({ keyCode: 229 });
    handleDesktopKeyPressImpl(event, ctx);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(onChangeText).not.toHaveBeenCalled();
    expect(handleDefaultSendAction).not.toHaveBeenCalled();
  });

  it("lets onKeyPressCallback handle the event first", () => {
    const onKeyPressCallback = vi.fn(() => true);
    const { ctx, onChangeText, handleDefaultSendAction } = makeContext({
      onKeyPressCallback,
    });
    const event = makeEvent({ shiftKey: true });
    handleDesktopKeyPressImpl(event, ctx);
    expect(onKeyPressCallback).toHaveBeenCalledWith({
      key: "Enter",
      preventDefault: expect.any(Function),
    });
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(onChangeText).not.toHaveBeenCalled();
    expect(handleDefaultSendAction).not.toHaveBeenCalled();
  });

  it("falls through to newline when onKeyPressCallback returns false", () => {
    const onKeyPressCallback = vi.fn(() => false);
    const { ctx, onChangeText } = makeContext({ onKeyPressCallback });
    const event = makeEvent({ altKey: true });
    handleDesktopKeyPressImpl(event, ctx);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(onChangeText).toHaveBeenCalledWith("hello world\n");
  });
});

describe("handleDesktopKeyPressImpl non-Enter keys", () => {
  it("ignores non-Enter keys", () => {
    const { ctx, onChangeText, handleDefaultSendAction } = makeContext();
    const event = makeEvent({ key: "Escape" });
    handleDesktopKeyPressImpl(event, ctx);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(onChangeText).not.toHaveBeenCalled();
    expect(handleDefaultSendAction).not.toHaveBeenCalled();
  });
});
