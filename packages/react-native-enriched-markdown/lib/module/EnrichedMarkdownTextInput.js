"use strict";

import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef } from 'react';
import EnrichedMarkdownTextInputNativeComponent, { Commands } from './EnrichedMarkdownTextInputNativeComponent';
import { Platform } from 'react-native';
import { normalizeMarkdownShortcuts } from "./normalizeMarkdownShortcuts.js";
import { normalizeMarkdownTextInputStyle } from "./normalizeMarkdownTextInputStyle.js";
import { normalizeMenuItem } from "./normalizeMenuItem.js";
import { toNativeRegexConfig } from "./utils/regexParser.js";
import { TextInputState } from "./utils/textInputState.js";
import { usePressability } from "./utils/usePressability.js";
import { jsx as _jsx } from "react/jsx-runtime";
const VALID_HEADING_LEVELS = new Set([1, 2, 3, 4, 5, 6]);
function toHeadingLevel(n) {
  return VALID_HEADING_LEVELS.has(n) ? n : 1;
}

/**
 * Per-item shape: `{ enabled }` toggles visibility, `label` overrides the
 * English default. Wire `label` to your i18n library to localize the menu.
 */

/** Controls the individual items inside the Format submenu. */

/**
 * Which typed markdown block prefixes convert into blocks. An omitted key is
 * off, so `{ heading: true }` enables headings and nothing else.
 */

function getNativeRef(ref) {
  if (ref.current == null) {
    throw new Error('EnrichedMarkdownTextInput: native ref is not attached. Ensure the component is mounted.');
  }
  return ref.current;
}
export const EnrichedMarkdownTextInput = ({
  ref,
  markdownStyle,
  style,
  defaultValue,
  placeholder,
  placeholderTextColor,
  editable = true,
  autoFocus = false,
  scrollEnabled = true,
  markdownShortcuts,
  autoCapitalize = 'sentences',
  multiline = true,
  cursorColor,
  selectionColor,
  onChangeText,
  onChangeMarkdown,
  onChangeSelection,
  onChangeState,
  onKeyPress,
  onCaretRectChange,
  onLinkDetected,
  mentionIndicators,
  onStartMention,
  onChangeMention,
  onEndMention,
  onFocus,
  onBlur,
  onPress,
  onPressIn,
  onPressOut,
  hitSlop,
  rejectResponderTermination = true,
  contextMenuItems,
  selectionMenuConfig,
  formatMenuConfig,
  linkRegex: _linkRegex,
  writingDirection = 'first-strong',
  ...rest
}) => {
  const nativeRef = useRef(null);
  // Freeze `defaultValue` at mount (RN TextInput semantics): post-mount changes are ignored.
  const initialDefaultValue = useRef(defaultValue).current;
  const nextRequestId = useRef(1);
  const pendingRequests = useRef(new Map());
  const pendingCaretRectRequests = useRef(new Map());
  const contextMenuCallbacksRef = useRef(new Map());
  useEffect(() => {
    const callbacksMap = new Map();
    if (contextMenuItems) {
      for (const item of contextMenuItems) {
        callbacksMap.set(item.text, item.onPress);
      }
    }
    contextMenuCallbacksRef.current = callbacksMap;
  }, [contextMenuItems]);
  const nativeContextMenuItems = useMemo(() => contextMenuItems?.filter(item => item.visible !== false).map(item => ({
    text: item.text,
    icon: item.icon
  })), [contextMenuItems]);
  useEffect(() => {
    const pending = pendingRequests.current;
    const pendingCaretRect = pendingCaretRectRequests.current;
    return () => {
      const err = new Error('Component unmounted');
      pending.forEach(({
        reject
      }) => reject(err));
      pending.clear();
      pendingCaretRect.forEach(({
        reject
      }) => reject(err));
      pendingCaretRect.clear();
    };
  }, []);

  /**
   * Mirrors the built-in TextInput's TextInputState integration so scroll
   * containers' keyboardShouldPersistTaps logic and Keyboard.dismiss treat
   * this input like a native TextInput. See utils/textInputState.ts for the
   * full rationale. The unmount cleanup blurs through blurTextInput so both
   * the registry entry and the native focus are released, matching the
   * TextInput unmount path.
   */
  useLayoutEffect(() => {
    const instance = nativeRef.current;
    if (instance == null) return;
    TextInputState.registerInput(instance);
    return () => {
      if (TextInputState.currentlyFocusedInput() === instance) {
        TextInputState.blurTextInput(instance);
      }
      TextInputState.unregisterInput(instance);
    };
  }, []);
  const normalizedStyle = normalizeMarkdownTextInputStyle(markdownStyle);
  const normalizedSelectionMenuConfig = useMemo(() => {
    const format = normalizeMenuItem(selectionMenuConfig?.format, true, 'Format');
    const copyAsMarkdown = normalizeMenuItem(selectionMenuConfig?.copyAsMarkdown, true, 'Copy as Markdown');
    return {
      format: format.enabled,
      formatLabel: format.label,
      copyAsMarkdown: copyAsMarkdown.enabled,
      copyAsMarkdownLabel: copyAsMarkdown.label
    };
  }, [selectionMenuConfig]);
  const normalizedFormatMenuConfig = useMemo(() => {
    const bold = normalizeMenuItem(formatMenuConfig?.bold, true, 'Bold');
    const italic = normalizeMenuItem(formatMenuConfig?.italic, true, 'Italic');
    const underline = normalizeMenuItem(formatMenuConfig?.underline, true, 'Underline');
    const strikethrough = normalizeMenuItem(formatMenuConfig?.strikethrough, true, 'Strikethrough');
    const spoiler = normalizeMenuItem(formatMenuConfig?.spoiler, true, 'Spoiler');
    const link = normalizeMenuItem(formatMenuConfig?.link, true, 'Link');
    return {
      bold: bold.enabled,
      boldLabel: bold.label,
      italic: italic.enabled,
      italicLabel: italic.label,
      underline: underline.enabled,
      underlineLabel: underline.label,
      strikethrough: strikethrough.enabled,
      strikethroughLabel: strikethrough.label,
      spoiler: spoiler.enabled,
      spoilerLabel: spoiler.label,
      link: link.enabled,
      linkLabel: link.label
    };
  }, [formatMenuConfig]);
  const normalizedMarkdownShortcuts = useMemo(() => normalizeMarkdownShortcuts(markdownShortcuts), [markdownShortcuts]);
  const linkRegex = useMemo(() => toNativeRegexConfig(_linkRegex), [_linkRegex]);
  const handleLinkDetected = useCallback(e => {
    const {
      text,
      url,
      start,
      end
    } = e.nativeEvent;
    onLinkDetected?.({
      text,
      url,
      start,
      end
    });
  }, [onLinkDetected]);
  const handleChangeText = useCallback(e => {
    onChangeText?.(e.nativeEvent.value);
  }, [onChangeText]);
  const handleChangeMarkdown = useCallback(e => {
    onChangeMarkdown?.(e.nativeEvent.value);
  }, [onChangeMarkdown]);
  const handleChangeSelection = useCallback(e => {
    const {
      start,
      end
    } = e.nativeEvent;
    onChangeSelection?.({
      start,
      end
    });
  }, [onChangeSelection]);
  const handleChangeState = useCallback(e => {
    const {
      bold,
      italic,
      underline,
      strikethrough,
      spoiler,
      link,
      heading,
      unorderedList,
      orderedList
    } = e.nativeEvent;
    onChangeState?.({
      bold,
      italic,
      underline,
      strikethrough,
      spoiler,
      link,
      heading: {
        ...heading,
        level: toHeadingLevel(heading.level)
      },
      unorderedList,
      orderedList
    });
  }, [onChangeState]);
  const handleCaretRectChange = useCallback(e => {
    const {
      x,
      y,
      width,
      height
    } = e.nativeEvent;
    onCaretRectChange?.({
      x,
      y,
      width,
      height
    });
  }, [onCaretRectChange]);
  const handleStartMention = useCallback(e => {
    onStartMention?.(e.nativeEvent);
  }, [onStartMention]);
  const handleChangeMention = useCallback(e => {
    onChangeMention?.(e.nativeEvent);
  }, [onChangeMention]);
  const handleEndMention = useCallback(e => {
    onEndMention?.(e.nativeEvent);
  }, [onEndMention]);
  const handleFocus = useCallback(() => {
    TextInputState.focusInput(nativeRef.current);
    onFocus?.();
  }, [onFocus]);
  const handleBlur = useCallback(() => {
    TextInputState.blurInput(nativeRef.current);
    onBlur?.();
  }, [onBlur]);

  /**
   * React Native TextInput attaches usePressability to the native host so taps
   * claim the JS touch responder and ancestor Pressable handlers do not also
   * run.
   * https://github.com/react/react-native/blob/v0.86.2/packages/react-native/Libraries/Components/TextInput/TextInput.js#L582-L616
   */
  const pressabilityConfig = useMemo(() => ({
    cancelable: Platform.OS === 'ios' ? !rejectResponderTermination : undefined,
    hitSlop,
    onPress: event => {
      onPress?.(event);
      if (editable !== false) {
        // Same call TextInput's host focus() makes. A tap on the text view
        // focuses it natively, which makes this a no-op; it matters when the
        // press lands outside the native view, e.g. in the hitSlop area.
        TextInputState.focusTextInput(nativeRef.current);
      }
    },
    onPressIn,
    onPressOut
  }), [editable, hitSlop, onPress, onPressIn, onPressOut, rejectResponderTermination]);

  // TextInput handles onBlur and onFocus events
  // so omitting onBlur and onFocus pressability handlers here.
  //
  // Same logic as https://github.com/react/react-native/blob/v0.86.2/packages/react-native/Libraries/Components/TextInput/TextInput.js#L629
  const {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    onBlur: _onBlur,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    onFocus: _onFocus,
    ...pressabilityHandlers
  } = usePressability(pressabilityConfig) ?? {};
  const handleRequestMarkdownResult = useCallback(e => {
    const {
      requestId,
      markdown
    } = e.nativeEvent;
    const pending = pendingRequests.current.get(requestId);
    if (!pending) return;
    pending.resolve(markdown);
    pendingRequests.current.delete(requestId);
  }, []);
  const handleRequestCaretRectResult = useCallback(e => {
    const {
      requestId,
      x,
      y,
      width,
      height
    } = e.nativeEvent;
    const pending = pendingCaretRectRequests.current.get(requestId);
    if (!pending) return;
    pending.resolve({
      x,
      y,
      width,
      height
    });
    pendingCaretRectRequests.current.delete(requestId);
  }, []);
  const handleContextMenuItemPress = useCallback(e => {
    const {
      itemText,
      selectedText,
      selectionStart,
      selectionEnd,
      styleState
    } = e.nativeEvent;
    const callback = contextMenuCallbacksRef.current.get(itemText);
    callback?.({
      text: selectedText,
      selection: {
        start: selectionStart,
        end: selectionEnd
      },
      styleState: {
        ...styleState,
        heading: {
          ...styleState.heading,
          level: toHeadingLevel(styleState.heading.level)
        }
      }
    });
  }, []);
  useImperativeHandle(ref, () => {
    const node = getNativeRef(nativeRef);
    // Codegen's ViewRef resolves to `never` with RN 0.84's function-based
    // HostComponent type — the cast is safe at runtime.
    const commandRef = node;
    return {
      measure: callback => node.measure(callback),
      measureInWindow: callback => node.measureInWindow(callback),
      measureLayout: (relativeToNativeNode, onSuccess, onFail) => node.measureLayout(relativeToNativeNode, onSuccess, onFail),
      focus: () => Commands.focus(commandRef),
      blur: () => Commands.blur(commandRef),
      setValue: markdown => Commands.setValue(commandRef, markdown),
      setSelection: (start, end) => Commands.setSelection(commandRef, start, end),
      toggleBold: () => Commands.toggleBold(commandRef),
      toggleItalic: () => Commands.toggleItalic(commandRef),
      toggleUnderline: () => Commands.toggleUnderline(commandRef),
      toggleStrikethrough: () => Commands.toggleStrikethrough(commandRef),
      toggleSpoiler: () => Commands.toggleSpoiler(commandRef),
      toggleHeading: level => Commands.toggleHeading(commandRef, level),
      toggleUnorderedList: () => Commands.toggleUnorderedList(commandRef),
      toggleOrderedList: () => Commands.toggleOrderedList(commandRef),
      indentList: () => Commands.indentList(commandRef),
      outdentList: () => Commands.outdentList(commandRef),
      setLink: url => Commands.setLink(commandRef, url),
      insertLink: (text, url) => Commands.insertLink(commandRef, text, url),
      insertText: text => Commands.insertText(commandRef, text),
      insertMention: (displayText, url) => Commands.insertMention(commandRef, displayText, url),
      startMention: indicator => Commands.startMention(commandRef, indicator),
      removeLink: () => Commands.removeLink(commandRef),
      copyToClipboard: () => Commands.copyToClipboard(commandRef),
      getMarkdown: () => new Promise((resolve, reject) => {
        const requestId = nextRequestId.current++;
        pendingRequests.current.set(requestId, {
          resolve,
          reject
        });
        Commands.requestMarkdown(commandRef, requestId);
      }),
      getCaretRect: () => new Promise((resolve, reject) => {
        const requestId = nextRequestId.current++;
        pendingCaretRectRequests.current.set(requestId, {
          resolve,
          reject
        });
        Commands.requestCaretRect(commandRef, requestId);
      })
    };
  });
  return /*#__PURE__*/_jsx(EnrichedMarkdownTextInputNativeComponent, {
    ref: nativeRef,
    style: style,
    markdownStyle: normalizedStyle,
    defaultValue: initialDefaultValue,
    placeholder: placeholder,
    placeholderTextColor: placeholderTextColor,
    editable: editable,
    autoFocus: autoFocus,
    scrollEnabled: scrollEnabled,
    markdownShortcuts: normalizedMarkdownShortcuts,
    autoCapitalize: autoCapitalize,
    multiline: multiline,
    cursorColor: cursorColor,
    selectionColor: selectionColor,
    isOnChangeMarkdownSet: onChangeMarkdown !== undefined,
    onChangeText: handleChangeText,
    onChangeMarkdown: handleChangeMarkdown,
    onChangeSelection: handleChangeSelection,
    onChangeState: handleChangeState,
    onInputKeyPress: onKeyPress,
    onLinkDetected: handleLinkDetected,
    onInputFocus: handleFocus,
    onInputBlur: handleBlur,
    onRequestMarkdownResult: handleRequestMarkdownResult,
    onRequestCaretRectResult: handleRequestCaretRectResult,
    onCaretRectChange: handleCaretRectChange,
    contextMenuItems: nativeContextMenuItems,
    selectionMenuConfig: normalizedSelectionMenuConfig,
    formatMenuConfig: normalizedFormatMenuConfig,
    mentionIndicators: mentionIndicators,
    onContextMenuItemPress: handleContextMenuItemPress,
    linkRegex: linkRegex,
    writingDirection: writingDirection,
    onStartMention: handleStartMention,
    onChangeMention: handleChangeMention,
    onEndMention: handleEndMention
    // Explicitly pass through hitSlop because the native view subclasses
    // RCTViewComponentView and makes use of hitSlop too
    ,
    hitSlop: hitSlop,
    ...rest,
    ...pressabilityHandlers
  });
};
export default EnrichedMarkdownTextInput;
//# sourceMappingURL=EnrichedMarkdownTextInput.js.map