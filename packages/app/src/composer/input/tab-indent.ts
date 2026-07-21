export interface ComposerTabIndentInput {
  value: string;
  selectionStart: number | null | undefined;
  selectionEnd: number | null | undefined;
}

export interface ComposerTabIndentResult {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

/**
 * Pure helper: insert a tab character at the current selection (or replace it).
 * Used by the web composer Tab key handler so focus does not leave the textarea.
 */
export function insertComposerTabIndent(input: ComposerTabIndentInput): ComposerTabIndentResult {
  const start = clampSelectionIndex(input.selectionStart, input.value.length);
  const end = clampSelectionIndex(input.selectionEnd, input.value.length);
  const selectionStart = Math.min(start, end);
  const selectionEnd = Math.max(start, end);
  const cursor = selectionStart + 1;
  return {
    value: `${input.value.slice(0, selectionStart)}\t${input.value.slice(selectionEnd)}`,
    selectionStart: cursor,
    selectionEnd: cursor,
  };
}

export interface TabModifierKeys {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

/** Plain Tab only — Shift+Tab (mode-cycle) and modified Tabs are not indentation. */
export function isPlainTabKey(event: TabModifierKeys): boolean {
  return (
    event.key === "Tab" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey
  );
}

export interface ResolveComposerTabKeyDownInput {
  event: TabModifierKeys;
  value: string;
  selectionStart: number | null | undefined;
  selectionEnd: number | null | undefined;
  disabled: boolean;
  isDictating: boolean;
  isRealtimeVoiceForCurrentAgent: boolean;
  /**
   * Host autocomplete/key interceptor. Return true when Tab was consumed
   * (e.g. command suggestions visible). May call preventDefault itself.
   */
  onKeyPressCallback?: (event: { key: string; preventDefault: () => void }) => boolean;
}

export type ResolveComposerTabKeyDownResult =
  | { kind: "ignore" }
  | {
      kind: "autocomplete";
      /** True when the autocomplete callback requested preventDefault. */
      shouldPreventDefault: boolean;
    }
  | {
      kind: "insert";
      value: string;
      selectionStart: number;
      selectionEnd: number;
    };

/**
 * Pure Tab keydown policy for the web composer textarea.
 *
 * - ignore: not a plain Tab, gated (disabled/dictation/voice), leave browser alone
 * - autocomplete: suggestions handled Tab first — do not insert indent
 * - insert: prevent focus navigation and insert `\t` at the caret/selection
 */
export function resolveComposerTabKeyDown(
  input: ResolveComposerTabKeyDownInput,
): ResolveComposerTabKeyDownResult {
  if (!isPlainTabKey(input.event)) {
    return { kind: "ignore" };
  }
  if (input.disabled || input.isDictating || input.isRealtimeVoiceForCurrentAgent) {
    return { kind: "ignore" };
  }

  if (input.onKeyPressCallback) {
    let shouldPreventDefault = false;
    const handled = input.onKeyPressCallback({
      key: input.event.key,
      preventDefault: () => {
        shouldPreventDefault = true;
      },
    });
    // Autocomplete path returns true after selecting. Honor its preventDefault so
    // focus does not leave the composer when a suggestion is accepted.
    if (handled) {
      return { kind: "autocomplete", shouldPreventDefault };
    }
  }

  const next = insertComposerTabIndent({
    value: input.value,
    selectionStart: input.selectionStart,
    selectionEnd: input.selectionEnd,
  });
  return {
    kind: "insert",
    value: next.value,
    selectionStart: next.selectionStart,
    selectionEnd: next.selectionEnd,
  };
}

/**
 * Apply a resolved Tab action to a textarea-like handle.
 * Returns true when the browser default (focus navigation) was prevented.
 */
export function applyComposerTabKeyDownResult(args: {
  result: ResolveComposerTabKeyDownResult;
  valueRef: { current: string };
  textarea: {
    value?: string;
    setSelectionRange?: (start: number, end: number) => void;
  };
  onChangeText: (nextValue: string) => void;
  preventDefault: () => void;
  scheduleSelectionRestore?: (restore: () => void) => void;
}): boolean {
  const { result } = args;
  if (result.kind === "ignore") {
    return false;
  }
  if (result.kind === "autocomplete") {
    if (result.shouldPreventDefault) {
      args.preventDefault();
    }
    return result.shouldPreventDefault;
  }

  args.preventDefault();
  args.valueRef.current = result.value;
  args.textarea.value = result.value;
  args.onChangeText(result.value);

  const restore = () => {
    args.textarea.setSelectionRange?.(result.selectionStart, result.selectionEnd);
  };
  restore();
  const schedule = args.scheduleSelectionRestore ?? defaultScheduleSelectionRestore;
  schedule(restore);
  return true;
}

function defaultScheduleSelectionRestore(restore: () => void): void {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(restore);
    return;
  }
  setTimeout(restore, 0);
}

function clampSelectionIndex(index: number | null | undefined, valueLength: number): number {
  if (typeof index !== "number" || !Number.isFinite(index)) {
    return valueLength;
  }
  return Math.max(0, Math.min(Math.trunc(index), valueLength));
}
