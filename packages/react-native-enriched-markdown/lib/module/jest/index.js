"use strict";

/**
 * Jest mock for `react-native-enriched-markdown`, wired up via
 * `jest.mock('react-native-enriched-markdown', () => require('react-native-enriched-markdown/jest'))`.
 * See docs/TESTING.md for setup and the behavior it mirrors.
 *
 * The two components are Fabric/codegen native views: under Jest there is no
 * native view manager, so rendering them or calling any imperative ref method
 * (each dispatches a native command) throws. These replacements render plain RN
 * primitives and expose every imperative method as a spy.
 *
 * Behavior mirrored from the native component: typing fires `onChangeText` and,
 * when set, `onChangeMarkdown` (the raw text stands in for parsed markdown);
 * `setValue()` updates the rendered text but emits no change events, matching
 * the native suppression of emits for programmatic updates.
 *
 * The mock is typed against the real public types, so `yarn typecheck` fails if
 * the API gains a prop or ref method the mock does not cover -- it cannot
 * silently drift from the real component.
 */
import { useImperativeHandle, useRef, useState } from 'react';
import { Text, TextInput } from 'react-native';
import { jsx as _jsx } from "react/jsx-runtime";
export { DEFAULT_ACCESSIBILITY_LABELS, resolveAccessibilityLabels } from "../accessibilityLabelDefaults.js";
const spy = impl => jest.fn(impl);
const EMPTY_CARET_RECT = {
  x: 0,
  y: 0,
  width: 0,
  height: 0
};
export const EnrichedMarkdownTextInput = ({
  ref,
  defaultValue,
  onChangeText,
  onChangeMarkdown,
  onFocus,
  onBlur,
  editable = true,
  placeholder,
  placeholderTextColor,
  autoFocus = false,
  multiline = true,
  scrollEnabled = true,
  style,
  testID,
  accessible,
  accessibilityLabel,
  accessibilityHint,
  accessibilityRole,
  accessibilityState,
  nativeID,
  markdownStyle: _markdownStyle,
  cursorColor: _cursorColor,
  selectionColor: _selectionColor,
  autoCapitalize: _autoCapitalize,
  onChangeSelection: _onChangeSelection,
  onChangeState: _onChangeState,
  onKeyPress: _onKeyPress,
  onCaretRectChange: _onCaretRectChange,
  onLinkDetected: _onLinkDetected,
  mentionIndicators: _mentionIndicators,
  onStartMention: _onStartMention,
  onChangeMention: _onChangeMention,
  onEndMention: _onEndMention,
  contextMenuItems: _contextMenuItems,
  selectionMenuConfig: _selectionMenuConfig,
  formatMenuConfig: _formatMenuConfig,
  linkRegex: _linkRegex,
  markdownShortcuts: _markdownShortcuts,
  writingDirection: _writingDirection
}) => {
  const [text, setText] = useState(defaultValue ?? '');
  const textRef = useRef(text);
  const inputRef = useRef(null);
  const applyText = next => {
    textRef.current = next;
    setText(next);
  };
  const handleChangeText = next => {
    applyText(next);
    onChangeText?.(next);
    onChangeMarkdown?.(next);
  };
  const instanceRef = useRef(null);
  if (instanceRef.current === null) {
    instanceRef.current = {
      focus: spy(() => inputRef.current?.focus()),
      blur: spy(() => inputRef.current?.blur()),
      measure: spy(callback => callback(0, 0, 0, 0, 0, 0)),
      measureInWindow: spy(callback => callback(0, 0, 0, 0)),
      measureLayout: spy((_relativeToNativeNode, onSuccess) => onSuccess(0, 0, 0, 0)),
      setValue: spy(markdown => applyText(markdown)),
      setSelection: spy((_start, _end) => {}),
      toggleBold: spy(() => {}),
      toggleItalic: spy(() => {}),
      toggleUnderline: spy(() => {}),
      toggleStrikethrough: spy(() => {}),
      toggleSpoiler: spy(() => {}),
      toggleHeading: spy(_level => {}),
      toggleUnorderedList: spy(() => {}),
      toggleOrderedList: spy(() => {}),
      indentList: spy(() => {}),
      outdentList: spy(() => {}),
      setLink: spy(_url => {}),
      insertLink: spy((_text, _url) => {}),
      insertText: spy(_text => {}),
      insertMention: spy((_displayText, _url) => {}),
      startMention: spy(_indicator => {}),
      removeLink: spy(() => {}),
      copyToClipboard: spy(() => {}),
      getMarkdown: spy(() => Promise.resolve(textRef.current)),
      getCaretRect: spy(() => Promise.resolve(EMPTY_CARET_RECT))
    };
  }
  useImperativeHandle(ref, () => instanceRef.current);
  return /*#__PURE__*/_jsx(TextInput, {
    ref: inputRef,
    value: text,
    onChangeText: handleChangeText,
    onFocus: () => onFocus?.(),
    onBlur: () => onBlur?.(),
    editable: editable,
    placeholder: placeholder,
    placeholderTextColor: placeholderTextColor,
    autoFocus: autoFocus,
    multiline: multiline,
    scrollEnabled: scrollEnabled,
    style: style,
    testID: testID,
    accessible: accessible,
    accessibilityLabel: accessibilityLabel,
    accessibilityHint: accessibilityHint,
    accessibilityRole: accessibilityRole,
    accessibilityState: accessibilityState,
    nativeID: nativeID
  });
};

// Composable transforms: split raw-string segments into React children.
// To add a feature, write a transform and append it to `buildChildren`.

const INLINE_FMT_RE = /\*{1,2}|_{1,2}/g;
const LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;
const TASK_ITEM_RE = /^- \[([ xX])\] (.+)$/gm;
function stripInlineFormatting(text) {
  return text.replace(INLINE_FMT_RE, '');
}
function splitByPattern(segment, regex, renderMatch) {
  const parts = [];
  let lastIndex = 0;
  regex.lastIndex = 0;
  let match;
  while ((match = regex.exec(segment)) !== null) {
    if (match.index > lastIndex) {
      parts.push(segment.slice(lastIndex, match.index));
    }
    parts.push(renderMatch(match));
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < segment.length) {
    parts.push(segment.slice(lastIndex));
  }
  return parts.length > 0 ? parts : [segment];
}
function applyTransform(children, transformFn) {
  return children.flatMap(child => typeof child === 'string' ? transformFn(child) : child);
}
function createLinkTransform(onLinkPress, onLinkLongPress) {
  let keyCounter = 0;
  return segment => splitByPattern(segment, LINK_RE, match => {
    const linkText = stripInlineFormatting(match[1]);
    const url = match[2];
    return /*#__PURE__*/_jsx(Text, {
      accessibilityRole: "link",
      onPress: () => onLinkPress?.({
        url
      }),
      onLongPress: onLinkLongPress ? () => onLinkLongPress({
        url
      }) : undefined,
      children: linkText
    }, `link-${keyCounter++}`);
  });
}
function createTaskListTransform(onTaskListItemPress) {
  let itemIndex = 0;
  return segment => splitByPattern(segment, TASK_ITEM_RE, match => {
    const checked = match[1] !== ' ';
    const text = match[2];
    const currentIndex = itemIndex++;
    return /*#__PURE__*/_jsx(Text, {
      accessibilityRole: "checkbox",
      accessibilityState: {
        checked
      },
      onPress: () => onTaskListItemPress?.({
        index: currentIndex,
        checked: !checked,
        text
      }),
      children: `${checked ? '☑' : '☐'} ${text}`
    }, `task-${currentIndex}`);
  });
}
function buildChildren(markdown, opts) {
  let children = [String(markdown ?? '')];
  const transforms = [opts.onTaskListItemPress ? createTaskListTransform(opts.onTaskListItemPress) : undefined, opts.onLinkPress || opts.onLinkLongPress ? createLinkTransform(opts.onLinkPress, opts.onLinkLongPress) : undefined].filter(t => t != null);
  for (const transform of transforms) {
    children = applyTransform(children, transform);
  }
  return children;
}
export const EnrichedMarkdownText = ({
  markdown,
  containerStyle,
  testID,
  accessible,
  accessibilityLabel,
  accessibilityHint,
  accessibilityRole,
  accessibilityState,
  nativeID,
  markdownStyle: _markdownStyle,
  onLinkPress,
  onLinkLongPress,
  onTaskListItemPress,
  enableLinkPreview: _enableLinkPreview,
  selectable: _selectable,
  md4cFlags: _md4cFlags,
  allowFontScaling: _allowFontScaling,
  maxFontSizeMultiplier: _maxFontSizeMultiplier,
  allowTrailingMargin: _allowTrailingMargin,
  flavor: _flavor,
  streamingAnimation: _streamingAnimation,
  streamingConfig: _streamingConfig,
  spoilerOverlay: _spoilerOverlay,
  contextMenuItems: _contextMenuItems,
  linkContextMenuItems: _linkContextMenuItems,
  imageRequestHeaders: _imageRequestHeaders,
  linkPillContent: _linkPillContent,
  selectionMenuConfig: _selectionMenuConfig,
  accessibilityLabels: _accessibilityLabels,
  selectionColor: _selectionColor,
  selectionHandleColor: _selectionHandleColor,
  textBreakStrategy: _textBreakStrategy,
  lineBreakStrategyIOS: _lineBreakStrategyIOS,
  writingDirection: _writingDirection
}) => {
  return /*#__PURE__*/_jsx(Text, {
    style: containerStyle,
    testID: testID,
    accessible: accessible,
    accessibilityLabel: accessibilityLabel,
    accessibilityHint: accessibilityHint,
    accessibilityRole: accessibilityRole,
    accessibilityState: accessibilityState,
    nativeID: nativeID,
    children: buildChildren(markdown, {
      onLinkPress,
      onLinkLongPress,
      onTaskListItemPress
    })
  });
};
//# sourceMappingURL=index.js.map