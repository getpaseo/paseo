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
import type { ComponentRef, ReactNode } from 'react';
import { Text, TextInput } from 'react-native';
import type {
  CaretRect,
  EnrichedMarkdownTextInputInstance,
  EnrichedMarkdownTextInputProps,
} from '../EnrichedMarkdownTextInput';
import type { EnrichedMarkdownTextProps } from '../native/EnrichedMarkdownText';
import type {
  LinkPressEvent,
  LinkLongPressEvent,
  TaskListItemPressEvent,
} from '../types/events';

export {
  DEFAULT_ACCESSIBILITY_LABELS,
  resolveAccessibilityLabels,
} from '../accessibilityLabelDefaults';

type AnyFn = (...args: any[]) => any;
declare const jest: { fn: <T extends AnyFn>(impl?: T) => T };

const spy = <T extends AnyFn>(impl?: T): T => jest.fn(impl);

const EMPTY_CARET_RECT: CaretRect = { x: 0, y: 0, width: 0, height: 0 };

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
  writingDirection: _writingDirection,
}: EnrichedMarkdownTextInputProps) => {
  const [text, setText] = useState(defaultValue ?? '');
  const textRef = useRef(text);
  const inputRef = useRef<ComponentRef<typeof TextInput> | null>(null);

  const applyText = (next: string) => {
    textRef.current = next;
    setText(next);
  };

  const handleChangeText = (next: string) => {
    applyText(next);
    onChangeText?.(next);
    onChangeMarkdown?.(next);
  };

  const instanceRef = useRef<EnrichedMarkdownTextInputInstance | null>(null);
  if (instanceRef.current === null) {
    instanceRef.current = {
      focus: spy(() => inputRef.current?.focus()),
      blur: spy(() => inputRef.current?.blur()),
      measure: spy((callback) => callback(0, 0, 0, 0, 0, 0)),
      measureInWindow: spy((callback) => callback(0, 0, 0, 0)),
      measureLayout: spy((_relativeToNativeNode, onSuccess) =>
        onSuccess(0, 0, 0, 0)
      ),
      setValue: spy((markdown: string) => applyText(markdown)),
      setSelection: spy((_start: number, _end: number) => {}),
      toggleBold: spy(() => {}),
      toggleItalic: spy(() => {}),
      toggleUnderline: spy(() => {}),
      toggleStrikethrough: spy(() => {}),
      toggleSpoiler: spy(() => {}),
      toggleHeading: spy((_level) => {}),
      toggleUnorderedList: spy(() => {}),
      toggleOrderedList: spy(() => {}),
      indentList: spy(() => {}),
      outdentList: spy(() => {}),
      setLink: spy((_url: string) => {}),
      insertLink: spy((_text: string, _url: string) => {}),
      insertText: spy((_text: string) => {}),
      insertMention: spy((_displayText: string, _url: string) => {}),
      startMention: spy((_indicator: string) => {}),
      removeLink: spy(() => {}),
      copyToClipboard: spy(() => {}),
      getMarkdown: spy(() => Promise.resolve(textRef.current)),
      getCaretRect: spy(() => Promise.resolve(EMPTY_CARET_RECT)),
    };
  }

  useImperativeHandle(ref, () => instanceRef.current!);

  return (
    <TextInput
      ref={inputRef}
      value={text}
      onChangeText={handleChangeText}
      onFocus={() => onFocus?.()}
      onBlur={() => onBlur?.()}
      editable={editable}
      placeholder={placeholder}
      placeholderTextColor={placeholderTextColor}
      autoFocus={autoFocus}
      multiline={multiline}
      scrollEnabled={scrollEnabled}
      style={style}
      testID={testID}
      accessible={accessible}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityRole={accessibilityRole}
      accessibilityState={accessibilityState}
      nativeID={nativeID}
    />
  );
};

// Composable transforms: split raw-string segments into React children.
// To add a feature, write a transform and append it to `buildChildren`.
type Segment = string | ReactNode;
type TransformFn = (text: string) => Segment[];

type BuildChildrenOptions = Pick<
  EnrichedMarkdownTextProps,
  'onLinkPress' | 'onLinkLongPress' | 'onTaskListItemPress'
>;

const INLINE_FMT_RE = /\*{1,2}|_{1,2}/g;
const LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;
const TASK_ITEM_RE = /^- \[([ xX])\] (.+)$/gm;

function stripInlineFormatting(text: string): string {
  return text.replace(INLINE_FMT_RE, '');
}

function splitByPattern(
  segment: string,
  regex: RegExp,
  renderMatch: (match: RegExpExecArray) => Segment
): Segment[] {
  const parts: Segment[] = [];
  let lastIndex = 0;
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
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

function applyTransform(
  children: Segment[],
  transformFn: TransformFn
): Segment[] {
  return children.flatMap((child) =>
    typeof child === 'string' ? transformFn(child) : child
  );
}

function createLinkTransform(
  onLinkPress?: (event: LinkPressEvent) => void,
  onLinkLongPress?: (event: LinkLongPressEvent) => void
): TransformFn {
  let keyCounter = 0;
  return (segment) =>
    splitByPattern(segment, LINK_RE, (match) => {
      const linkText = stripInlineFormatting(match[1]!);
      const url = match[2]!;
      return (
        <Text
          key={`link-${keyCounter++}`}
          accessibilityRole="link"
          onPress={() => onLinkPress?.({ url })}
          onLongPress={
            onLinkLongPress ? () => onLinkLongPress({ url }) : undefined
          }
        >
          {linkText}
        </Text>
      );
    });
}

function createTaskListTransform(
  onTaskListItemPress?: (event: TaskListItemPressEvent) => void
): TransformFn {
  let itemIndex = 0;
  return (segment) =>
    splitByPattern(segment, TASK_ITEM_RE, (match) => {
      const checked = match[1] !== ' ';
      const text = match[2]!;
      const currentIndex = itemIndex++;
      return (
        <Text
          key={`task-${currentIndex}`}
          accessibilityRole="checkbox"
          accessibilityState={{ checked }}
          onPress={() =>
            onTaskListItemPress?.({
              index: currentIndex,
              checked: !checked,
              text,
            })
          }
        >
          {`${checked ? '☑' : '☐'} ${text}`}
        </Text>
      );
    });
}

function buildChildren(
  markdown: string | undefined,
  opts: BuildChildrenOptions
): Segment[] {
  let children: Segment[] = [String(markdown ?? '')];

  const transforms: TransformFn[] = [
    opts.onTaskListItemPress
      ? createTaskListTransform(opts.onTaskListItemPress)
      : undefined,
    opts.onLinkPress || opts.onLinkLongPress
      ? createLinkTransform(opts.onLinkPress, opts.onLinkLongPress)
      : undefined,
  ].filter((t): t is TransformFn => t != null);

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
  writingDirection: _writingDirection,
}: EnrichedMarkdownTextProps) => {
  return (
    <Text
      style={containerStyle}
      testID={testID}
      accessible={accessible}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityRole={accessibilityRole}
      accessibilityState={accessibilityState}
      nativeID={nativeID}
    >
      {buildChildren(markdown, {
        onLinkPress,
        onLinkLongPress,
        onTaskListItemPress,
      })}
    </Text>
  );
};
