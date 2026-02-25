import {
  View,
  Text,
  Image,
  Pressable,
  ActivityIndicator,
  type LayoutChangeEvent,
  StyleProp,
  ViewStyle,
  Platform,
} from "react-native";
import {
  useState,
  useEffect,
  useRef,
  memo,
  useMemo,
  useCallback,
  createContext,
  useContext,
} from "react";
import type { ReactNode, ComponentType } from "react";
import Markdown, { MarkdownIt } from "react-native-markdown-display";
import MaskedView from "@react-native-masked-view/masked-view";
import {
  Circle,
  Info,
  CheckCircle,
  XCircle,
  FileText,
  ChevronRight,
  ChevronDown,
  Check,
  CheckSquare,
  X,
  Copy,
  TriangleAlertIcon,
  Scissors,
} from "lucide-react-native";
import {
  StyleSheet,
  useUnistyles,
  UnistylesRuntime,
} from "react-native-unistyles";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, {
  Defs,
  LinearGradient as SvgLinearGradient,
  Rect,
  Stop,
} from "react-native-svg";
import { theme } from "@/styles/theme";
import {
  createMarkdownStyles,
} from "@/styles/markdown-styles";
import { Colors, Fonts } from "@/constants/theme";
import * as Clipboard from "expo-clipboard";
import type { TodoEntry, UserMessageImageAttachment } from "@/types/stream";
import type { ToolCallDetail } from "@server/server/agent/agent-sdk-types";
import {
  buildToolCallDisplayModel,
} from "@/utils/tool-call-display";
import { resolveToolCallIcon } from "@/utils/tool-call-icon";
import { getNowMs, isPerfLoggingEnabled, perfLog } from "@/utils/perf";
import { parseInlinePathToken, type InlinePathTarget } from "@/utils/inline-path";
import { getMarkdownListMarker } from "@/utils/markdown-list";
import { openExternalUrl } from "@/utils/open-external-url";
import { markScrollInvestigationEvent } from "@/utils/scroll-jank-investigation";
export type { InlinePathTarget } from "@/utils/inline-path";
import { useToolCallSheet } from "./tool-call-sheet";
import { ToolCallDetailsContent } from "./tool-call-details";
import { useAttachmentPreviewUrl } from "@/attachments/use-attachment-preview-url";

interface UserMessageProps {
  message: string;
  images?: UserMessageImageAttachment[];
  timestamp: number;
  isFirstInGroup?: boolean;
  isLastInGroup?: boolean;
  disableOuterSpacing?: boolean;
}

const MessageOuterSpacingContext = createContext(false);

export function MessageOuterSpacingProvider({
  disableOuterSpacing,
  children,
}: {
  disableOuterSpacing: boolean;
  children: ReactNode;
}) {
  return (
    <MessageOuterSpacingContext.Provider value={disableOuterSpacing}>
      {children}
    </MessageOuterSpacingContext.Provider>
  );
}

function useDisableOuterSpacing(disableOuterSpacing: boolean | undefined) {
  const contextValue = useContext(MessageOuterSpacingContext);
  return disableOuterSpacing ?? contextValue;
}

const WEB_TOOLCALL_SHIMMER_KEYFRAME_ID = "paseo-toolcall-shimmer-keyframes";
const WEB_TOOLCALL_SHIMMER_ANIMATION_NAME = "paseo-toolcall-shimmer";
const WEB_TOOLCALL_SHIMMER_KEYFRAME_CSS = `
  @keyframes ${WEB_TOOLCALL_SHIMMER_ANIMATION_NAME} {
    0% {
      background-position: var(--paseo-shimmer-start, -200px) 0;
    }
    100% {
      background-position: var(--paseo-shimmer-end, 200px) 0;
    }
  }
`;
let webToolCallShimmerRegistered = false;
const SCROLL_EDGE_EPSILON = 0.5;
type ScrollAxis = "x" | "y";

function ensureWebToolCallShimmerKeyframes() {
  if (Platform.OS !== "web") {
    return;
  }
  if (typeof document === "undefined") {
    return;
  }
  const existing = document.getElementById(WEB_TOOLCALL_SHIMMER_KEYFRAME_ID);
  if (existing) {
    if (existing.textContent !== WEB_TOOLCALL_SHIMMER_KEYFRAME_CSS) {
      existing.textContent = WEB_TOOLCALL_SHIMMER_KEYFRAME_CSS;
    }
    webToolCallShimmerRegistered = true;
    return;
  }
  if (webToolCallShimmerRegistered) {
    return;
  }
  const styleElement = document.createElement("style");
  styleElement.id = WEB_TOOLCALL_SHIMMER_KEYFRAME_ID;
  styleElement.textContent = WEB_TOOLCALL_SHIMMER_KEYFRAME_CSS;
  document.head.appendChild(styleElement);
  webToolCallShimmerRegistered = true;
}

function getWheelEventElementTarget(
  event: WheelEvent,
  fallback: HTMLElement
): HTMLElement {
  const { target } = event;
  if (target instanceof HTMLElement) {
    return target;
  }
  if (target instanceof Node && target.parentElement) {
    return target.parentElement;
  }
  return fallback;
}

function canElementScrollInDirection(
  element: HTMLElement,
  axis: ScrollAxis,
  delta: number
): boolean {
  if (delta === 0) {
    return false;
  }

  const computedStyle = window.getComputedStyle(element);
  const overflow = axis === "x" ? computedStyle.overflowX : computedStyle.overflowY;
  const isScrollableOverflow =
    overflow === "auto" || overflow === "scroll" || overflow === "overlay";
  if (!isScrollableOverflow) {
    return false;
  }

  const scrollPosition = axis === "x" ? element.scrollLeft : element.scrollTop;
  const scrollSize =
    axis === "x" ? element.scrollWidth - element.clientWidth : element.scrollHeight - element.clientHeight;
  if (scrollSize <= SCROLL_EDGE_EPSILON) {
    return false;
  }

  if (delta > 0) {
    return scrollPosition < scrollSize - SCROLL_EDGE_EPSILON;
  }
  return scrollPosition > SCROLL_EDGE_EPSILON;
}

function canScrollInsideDetailFromTarget(
  detailRoot: HTMLElement,
  startElement: HTMLElement,
  axis: ScrollAxis,
  delta: number
): boolean {
  if (delta === 0) {
    return false;
  }

  let current: HTMLElement | null = startElement;
  while (current) {
    if (canElementScrollInDirection(current, axis, delta)) {
      return true;
    }
    if (current === detailRoot) {
      break;
    }
    current = current.parentElement;
  }
  return false;
}

function shouldStopDetailWheelPropagation(
  detailRoot: HTMLElement,
  event: WheelEvent
): boolean {
  const startElement = getWheelEventElementTarget(event, detailRoot);
  const verticalDelta = event.deltaY;
  const horizontalDelta =
    event.deltaX !== 0 ? event.deltaX : (event.shiftKey ? event.deltaY : 0);

  const hasVerticalIntent = Math.abs(verticalDelta) > SCROLL_EDGE_EPSILON;
  const hasHorizontalIntent = Math.abs(horizontalDelta) > SCROLL_EDGE_EPSILON;
  if (!hasVerticalIntent && !hasHorizontalIntent) {
    return false;
  }

  const canScrollVertically = hasVerticalIntent
    ? canScrollInsideDetailFromTarget(detailRoot, startElement, "y", verticalDelta)
    : false;
  const canScrollHorizontally = hasHorizontalIntent
    ? canScrollInsideDetailFromTarget(
        detailRoot,
        startElement,
        "x",
        horizontalDelta
      )
    : false;

  if (hasVerticalIntent && hasHorizontalIntent) {
    const isVerticalDominant = Math.abs(verticalDelta) >= Math.abs(horizontalDelta);
    return isVerticalDominant
      ? canScrollVertically || canScrollHorizontally
      : canScrollHorizontally || canScrollVertically;
  }

  if (hasVerticalIntent) {
    return canScrollVertically;
  }
  return canScrollHorizontally;
}

const userMessageStylesheet = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    justifyContent: "flex-end",
    paddingHorizontal: theme.spacing[2],
  },
  content: {
    alignItems: "flex-end",
    maxWidth: "100%",
  },
  containerSpacing: {
    marginBottom: theme.spacing[1],
  },
  containerFirstInGroup: {
    marginTop: theme.spacing[4],
  },
  containerLastInGroup: {
    marginBottom: theme.spacing[4],
  },
  bubble: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius["2xl"],
    borderTopRightRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
    minWidth: 0,
    flexShrink: 1,
  },
  text: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: 22,
    overflowWrap: "anywhere",
  },
  imagePreviewContainer: {
    flexDirection: "row",
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
  imagePreviewSpacing: {
    marginBottom: theme.spacing[2],
  },
  imagePill: {
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
    overflow: "hidden",
  },
  imageThumbnail: {
    width: 48,
    height: 48,
  },
  imageThumbnailPlaceholder: {
    width: 48,
    height: 48,
    backgroundColor: theme.colors.surface1,
  },
  copyButton: {
    alignSelf: "flex-end",
    padding: theme.spacing[1],
    marginTop: theme.spacing[2],
  },
  copyButtonHidden: {
    opacity: 0,
  },
  copyButtonVisible: {
    opacity: 1,
  },
}));

function UserMessageAttachmentThumbnail({
  image,
}: {
  image: UserMessageImageAttachment;
}) {
  const uri = useAttachmentPreviewUrl(image);
  if (!uri) {
    return <View style={userMessageStylesheet.imageThumbnailPlaceholder} />;
  }
  return <Image source={{ uri }} style={userMessageStylesheet.imageThumbnail} />;
}

export const UserMessage = memo(function UserMessage({
  message,
  images = [],
  timestamp,
  isFirstInGroup = true,
  isLastInGroup = true,
  disableOuterSpacing,
}: UserMessageProps) {
  const [messageHovered, setMessageHovered] = useState(false);
  const [copyButtonHovered, setCopyButtonHovered] = useState(false);
  const resolvedDisableOuterSpacing =
    useDisableOuterSpacing(disableOuterSpacing);
  const hasText = message.trim().length > 0;
  const hasImages = images.length > 0;
  const showCopyButton =
    hasText && (Platform.OS !== "web" || messageHovered || copyButtonHovered);

  return (
    <View
      style={[
        userMessageStylesheet.container,
        !resolvedDisableOuterSpacing && [
          isFirstInGroup && { marginTop: theme.spacing[4] },
          isLastInGroup && { marginBottom: theme.spacing[4] },
          !isFirstInGroup || !isLastInGroup
            ? { marginBottom: theme.spacing[1] }
            : undefined,
        ],
      ]}
    >
      <Pressable
        style={userMessageStylesheet.content}
        onHoverIn={
          Platform.OS === "web" ? () => setMessageHovered(true) : undefined
        }
        onHoverOut={
          Platform.OS === "web" ? () => setMessageHovered(false) : undefined
        }
      >
        <View style={userMessageStylesheet.bubble}>
          {hasImages ? (
            <View
              style={[
                userMessageStylesheet.imagePreviewContainer,
                hasText ? userMessageStylesheet.imagePreviewSpacing : undefined,
              ]}
            >
              {images.map((image, index) => (
                <View
                  key={`${image.id}-${index}`}
                  style={userMessageStylesheet.imagePill}
                >
                  <UserMessageAttachmentThumbnail image={image} />
                </View>
              ))}
            </View>
          ) : null}
          {hasText ? (
            <Text selectable style={userMessageStylesheet.text}>
              {message}
            </Text>
          ) : null}
        </View>
        {hasText ? (
          <TurnCopyButton
            getContent={() => message}
            containerStyle={[
              userMessageStylesheet.copyButton,
              showCopyButton
                ? userMessageStylesheet.copyButtonVisible
                : userMessageStylesheet.copyButtonHidden,
            ]}
            accessibilityLabel="Copy message"
            onHoverChange={setCopyButtonHovered}
          />
        ) : null}
      </Pressable>
    </View>
  );
});

interface AssistantMessageProps {
  message: string;
  timestamp: number;
  onInlinePathPress?: (target: InlinePathTarget) => void;
  disableOuterSpacing?: boolean;
}

export const assistantMessageStylesheet = StyleSheet.create((theme) => ({
  container: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[3],
  },
  containerSpacing: {
    marginBottom: theme.spacing[4],
  },
  // Used in custom markdownRules for inline code styling
  markdownCodeInline: {
    backgroundColor: theme.colors.surface2,
    color: theme.colors.foreground,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.sm,
    fontFamily: Fonts.mono,
    fontSize: 13,
  },
  markdownCodeInlineLink: {
    color: theme.colors.primary,
    textDecorationLine: "underline",
  },
  // Used in custom markdownRules for path chip styling
  pathChip: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    marginRight: theme.spacing[1],
    marginVertical: 2,
  },
  pathChipText: {
    color: theme.colors.foreground,
    fontFamily: Fonts.mono,
    fontSize: 13,
  },
}));

function getInlineCodeAutoLinkUrl(
  markdownParser: ReturnType<typeof MarkdownIt>,
  content: string
): string | null {
  const trimmed = content.trim();
  if (!trimmed) {
    return null;
  }

  const matches = markdownParser.linkify.match(trimmed) as
    | Array<{ index: number; lastIndex: number; url: string }>
    | null;
  if (!matches || matches.length !== 1) {
    return null;
  }

  const [match] = matches;
  if (!match || match.index !== 0 || match.lastIndex !== trimmed.length) {
    return null;
  }

  return match.url;
}

const turnCopyButtonStylesheet = StyleSheet.create((theme) => ({
  container: {
    alignSelf: "flex-start",
    padding: theme.spacing[2],
    paddingTop: 0,
  },
  iconColor: {
    color: theme.colors.foregroundMuted,
  },
  iconHoveredColor: {
    color: theme.colors.foreground,
  },
}));

interface TurnCopyButtonProps {
  getContent: () => string;
  containerStyle?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  copiedAccessibilityLabel?: string;
  onHoverChange?: (hovered: boolean) => void;
}

export const TurnCopyButton = memo(function TurnCopyButton({
  getContent,
  containerStyle,
  accessibilityLabel,
  copiedAccessibilityLabel,
  onHoverChange,
}: TurnCopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = useCallback(async () => {
    const content = getContent();
    if (!content) {
      return;
    }

    await Clipboard.setStringAsync(content);
    setCopied(true);

    if (copyTimeoutRef.current) {
      clearTimeout(copyTimeoutRef.current);
    }

    copyTimeoutRef.current = setTimeout(() => {
      setCopied(false);
      copyTimeoutRef.current = null;
    }, 1500);
  }, [getContent]);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  return (
    <Pressable
      onPress={handleCopy}
      onHoverIn={Platform.OS === "web" ? () => onHoverChange?.(true) : undefined}
      onHoverOut={Platform.OS === "web" ? () => onHoverChange?.(false) : undefined}
      style={[turnCopyButtonStylesheet.container, containerStyle]}
      accessibilityRole="button"
      accessibilityLabel={
        copied
          ? (copiedAccessibilityLabel ?? "Copied")
          : (accessibilityLabel ?? "Copy turn")
      }
    >
      {({ hovered }) => {
        const iconColor = hovered
          ? turnCopyButtonStylesheet.iconHoveredColor.color
          : turnCopyButtonStylesheet.iconColor.color;
        return copied ? (
          <Check size={18} color={iconColor} />
        ) : (
          <Copy size={18} color={iconColor} />
        );
      }}
    </Pressable>
  );
});

const expandableBadgeStylesheet = StyleSheet.create((theme) => ({
  container: {
    marginHorizontal: theme.spacing[2],
  },
  containerSpacing: {
    marginBottom: theme.spacing[1],
  },
  containerLastInSequence: {
    marginBottom: theme.spacing[4],
  },
  pressable: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    overflow: "hidden",
  },
  pressablePressed: {
    opacity: 0.9,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  labelRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    overflow: "hidden",
  },
  iconBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
    marginRight: theme.spacing[2],
    backgroundColor: "transparent",
  },
  label: {
    color: theme.colors.foreground,
    opacity: 0.88,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    flexShrink: 0,
  },
  labelLoading: {
    color: theme.colors.foreground,
    opacity: 0.72,
  },
  secondaryLabel: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    marginLeft: theme.spacing[2],
  },
  shimmerText: {
    color: "transparent",
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    flexShrink: 1,
  },
  spacer: {
    flex: 1,
  },
  chevron: {
    marginLeft: theme.spacing[1],
    flexShrink: 0,
  },
  detailWrapper: {
    borderBottomLeftRadius: theme.borderRadius.lg,
    borderBottomRightRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderTopWidth: 0,
    borderColor: theme.colors.border,
    padding: 0,
    gap: 0,
    flexShrink: 1,
    minWidth: 0,
    overflow: "hidden",
  },
  pressableExpanded: {
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
  },
  shimmerOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    flexDirection: "row",
    alignItems: "center",
    overflow: "hidden",
  },
  shimmerMaskRow: {
    flexDirection: "row",
    alignItems: "center",
    width: "100%",
    height: "100%",
  },
  nativeShimmerTrack: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    overflow: "hidden",
  },
  nativeShimmerPeak: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
  },
}));

export const AssistantMessage = memo(function AssistantMessage({
  message,
  timestamp,
  onInlinePathPress,
  disableOuterSpacing,
}: AssistantMessageProps) {
  const { theme } = useUnistyles();
  const resolvedDisableOuterSpacing =
    useDisableOuterSpacing(disableOuterSpacing);

  const markdownStyles = useMemo(() => createMarkdownStyles(theme), [theme]);

  const markdownParser = useMemo(
    () => MarkdownIt({ typographer: true, linkify: true }),
    []
  );

  const handleLinkPress = useCallback((url: string) => {
    void openExternalUrl(url);
    // react-native-markdown-display opens the link itself when this returns true.
    // We already handled it above, so return false to avoid duplicate opens.
    return false;
  }, []);

  const markdownRules = useMemo(() => {
    return {
      text: (
        node: any,
        _children: ReactNode[],
        _parent: any,
        styles: any,
        inheritedStyles: any = {}
      ) => (
        <Text key={node.key} style={[inheritedStyles, styles.text]}>
          {node.content}
        </Text>
      ),
      textgroup: (
        node: any,
        children: ReactNode[],
        _parent: any,
        styles: any,
        inheritedStyles: any = {}
      ) => (
        <Text
          key={node.key}
          style={[inheritedStyles, styles.textgroup]}
        >
          {children}
        </Text>
      ),
      code_block: (
        node: any,
        _children: ReactNode[],
        _parent: any,
        styles: any,
        inheritedStyles: any = {}
      ) => (
        <Text
          key={node.key}
          style={[inheritedStyles, styles.code_block]}
        >
          {node.content}
        </Text>
      ),
      fence: (
        node: any,
        _children: ReactNode[],
        _parent: any,
        styles: any,
        inheritedStyles: any = {}
      ) => (
        <Text key={node.key} style={[inheritedStyles, styles.fence]}>
          {node.content}
        </Text>
      ),
      code_inline: (
        node: any,
        _children: ReactNode[],
        _parent: any,
        _styles: any,
        inheritedStyles: any = {}
      ) => {
        const content = node.content ?? "";
        const parsed = onInlinePathPress
          ? parseInlinePathToken(content)
          : null;

        if (parsed) {
          return (
            <Text
              key={node.key}
              onPress={() => parsed && onInlinePathPress?.(parsed)}
              selectable={false}
              style={[
                assistantMessageStylesheet.pathChip,
                assistantMessageStylesheet.pathChipText,
              ]}
            >
              {content}
            </Text>
          );
        }

        const inlineCodeLinkUrl = getInlineCodeAutoLinkUrl(markdownParser, content);
        if (inlineCodeLinkUrl) {
          return (
            <Text
              key={node.key}
              accessibilityRole="link"
              onPress={() => {
                handleLinkPress(inlineCodeLinkUrl);
              }}
              style={[
                inheritedStyles,
                assistantMessageStylesheet.markdownCodeInline,
                assistantMessageStylesheet.markdownCodeInlineLink,
              ]}
            >
              {content}
            </Text>
          );
        }

        return (
          <Text
            key={node.key}
            style={[
              inheritedStyles,
              assistantMessageStylesheet.markdownCodeInline,
            ]}
          >
            {content}
          </Text>
        );
      },
      bullet_list: (
        node: any,
        children: ReactNode[],
        _parent: any,
        styles: any
      ) => (
        <View key={node.key} style={styles.bullet_list}>
          {children}
        </View>
      ),
      ordered_list: (
        node: any,
        children: ReactNode[],
        _parent: any,
        styles: any
      ) => (
        <View key={node.key} style={styles.ordered_list}>
          {children}
        </View>
      ),
      list_item: (
        node: any,
        children: ReactNode[],
        parent: any,
        styles: any
      ) => {
        const { isOrdered, marker } = getMarkdownListMarker(node, parent);
        const iconStyle = isOrdered
          ? styles.ordered_list_icon
          : styles.bullet_list_icon;
        const contentStyle = isOrdered
          ? styles.ordered_list_content
          : styles.bullet_list_content;

        return (
          <View key={node.key} style={styles.list_item}>
            <Text style={iconStyle}>{marker}</Text>
            <View
              style={[contentStyle, { flex: 1, flexShrink: 1, minWidth: 0 }]}
            >
              {children}
            </View>
          </View>
        );
      },
    };
  }, [handleLinkPress, markdownParser, onInlinePathPress]);

  return (
    <View
      testID="assistant-message"
      style={[
        assistantMessageStylesheet.container,
        !resolvedDisableOuterSpacing &&
          assistantMessageStylesheet.containerSpacing,
      ]}
    >
      <Markdown
        style={markdownStyles}
        rules={markdownRules}
        markdownit={markdownParser}
        onLinkPress={handleLinkPress}
      >
        {message}
      </Markdown>
    </View>
  );
});

interface ActivityLogProps {
  type: "system" | "info" | "success" | "error" | "artifact";
  message: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
  artifactId?: string;
  artifactType?: string;
  title?: string;
  onArtifactClick?: (artifactId: string) => void;
  disableOuterSpacing?: boolean;
}

const activityLogStylesheet = StyleSheet.create((theme) => ({
  pressable: {
    marginHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    overflow: "hidden",
  },
  pressableSpacing: {
    marginBottom: theme.spacing[1],
  },
  pressableActive: {
    opacity: 0.7,
  },
  systemBg: {
    backgroundColor: "rgba(39, 39, 42, 0.5)",
  },
  infoBg: {
    backgroundColor: "rgba(30, 58, 138, 0.3)",
  },
  successBg: {
    backgroundColor: "rgba(20, 83, 45, 0.3)",
  },
  errorBg: {
    backgroundColor: "rgba(127, 29, 29, 0.3)",
  },
  artifactBg: {
    backgroundColor: "rgba(30, 58, 138, 0.4)",
  },
  content: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 10,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  iconContainer: {
    flexShrink: 0,
  },
  textContainer: {
    flex: 1,
  },
  messageText: {
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  detailsRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: theme.spacing[1],
  },
  detailsText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginRight: theme.spacing[1],
  },
  metadataContainer: {
    marginTop: theme.spacing[2],
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    borderRadius: theme.borderRadius.base,
    padding: theme.spacing[2],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  metadataText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontFamily: Fonts.mono,
    lineHeight: 16,
  },
}));

export const ActivityLog = memo(function ActivityLog({
  type,
  message,
  timestamp,
  metadata,
  artifactId,
  artifactType,
  title,
  onArtifactClick,
  disableOuterSpacing,
}: ActivityLogProps) {
  const resolvedDisableOuterSpacing =
    useDisableOuterSpacing(disableOuterSpacing);
  const [isExpanded, setIsExpanded] = useState(false);

  const typeConfig = {
    system: {
      bg: activityLogStylesheet.systemBg,
      color: "#a1a1aa",
      Icon: Circle,
    },
    info: { bg: activityLogStylesheet.infoBg, color: "#60a5fa", Icon: Info },
    success: {
      bg: activityLogStylesheet.successBg,
      color: "#4ade80",
      Icon: CheckCircle,
    },
    error: {
      bg: activityLogStylesheet.errorBg,
      color: "#f87171",
      Icon: XCircle,
    },
    artifact: {
      bg: activityLogStylesheet.artifactBg,
      color: "#93c5fd",
      Icon: FileText,
    },
  };

  const config = typeConfig[type];
  const IconComponent = config.Icon;

  const handlePress = () => {
    if (type === "artifact" && artifactId && onArtifactClick) {
      onArtifactClick(artifactId);
    } else if (metadata) {
      setIsExpanded(!isExpanded);
    }
  };

  const displayMessage =
    type === "artifact" && artifactType && title
      ? `${artifactType}: ${title}`
      : message;

  const isInteractive = type === "artifact" || metadata;

  return (
    <Pressable
      onPress={handlePress}
      disabled={!isInteractive}
      style={[
        activityLogStylesheet.pressable,
        !resolvedDisableOuterSpacing && activityLogStylesheet.pressableSpacing,
        config.bg,
        isInteractive && activityLogStylesheet.pressableActive,
      ]}
    >
      <View style={activityLogStylesheet.content}>
        <View style={activityLogStylesheet.row}>
          <View style={activityLogStylesheet.iconContainer}>
            <IconComponent size={16} color={config.color} />
          </View>
          <View style={activityLogStylesheet.textContainer}>
            <Text
              style={[
                activityLogStylesheet.messageText,
                { color: config.color },
              ]}
            >
              {displayMessage}
            </Text>
            {metadata && (
              <View style={activityLogStylesheet.detailsRow}>
                <Text style={activityLogStylesheet.detailsText}>Details</Text>
                {isExpanded ? (
                  <ChevronDown size={12} color="#71717a" />
                ) : (
                  <ChevronRight size={12} color="#71717a" />
                )}
              </View>
            )}
          </View>
        </View>
        {isExpanded && metadata && (
          <View style={activityLogStylesheet.metadataContainer}>
            <Text style={activityLogStylesheet.metadataText}>
              {JSON.stringify(metadata, null, 2)}
            </Text>
          </View>
        )}
      </View>
    </Pressable>
  );
});

interface CompactionMarkerProps {
  status: "loading" | "completed";
  preTokens?: number;
}

const compactionStylesheet = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[2],
  },
  line: {
    flex: 1,
    height: 1,
    backgroundColor: theme.colors.border,
  },
  label: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  text: {
    fontFamily: Fonts.sans,
    fontSize: 13,
    color: theme.colors.foregroundMuted,
  },
}));

export const CompactionMarker = memo(function CompactionMarker({
  status,
  preTokens,
}: CompactionMarkerProps) {
  const label =
    status === "loading"
      ? "Compacting..."
      : preTokens
        ? `Context compacted (${Math.round(preTokens / 1000)}K tokens)`
        : "Context compacted";

  return (
    <View style={compactionStylesheet.container}>
      <View style={compactionStylesheet.line} />
      <View style={compactionStylesheet.label}>
        {status === "loading" ? (
          <ActivityIndicator size="small" color="#a1a1aa" />
        ) : (
          <Scissors size={12} color="#a1a1aa" />
        )}
        <Text style={compactionStylesheet.text}>{label}</Text>
      </View>
      <View style={compactionStylesheet.line} />
    </View>
  );
});

interface TodoListCardProps {
  items: TodoEntry[];
  disableOuterSpacing?: boolean;
}

const todoListCardStylesheet = StyleSheet.create((theme) => ({
  detailsWrapper: {
    padding: theme.spacing[2],
  },
  list: {
    gap: theme.spacing[1],
  },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  radioBadge: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: theme.colors.foregroundMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  radioBadgeIncomplete: {
    opacity: 0.55,
  },
  radioBadgeComplete: {
    opacity: 0.95,
  },
  itemText: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  itemTextCompleted: {
    color: theme.colors.foregroundMuted,
    textDecorationLine: "line-through",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));

export const TodoListCard = memo(function TodoListCard({
  items,
  disableOuterSpacing,
}: TodoListCardProps) {
  const { theme: unistylesTheme } = useUnistyles();
  const [isExpanded, setIsExpanded] = useState(false);

  const nextTask = useMemo(() => items.find((item) => !item.completed)?.text, [items]);

  const handleToggle = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  const renderDetails = useCallback(() => {
    return (
      <View style={todoListCardStylesheet.detailsWrapper}>
        <View style={todoListCardStylesheet.list}>
          {items.length === 0 ? (
            <Text style={todoListCardStylesheet.emptyText}>No tasks yet.</Text>
          ) : (
            items.map((item, idx) => (
              <View key={`${item.text}-${idx}`} style={todoListCardStylesheet.itemRow}>
                <View
                  style={[
                    todoListCardStylesheet.radioBadge,
                    item.completed
                      ? todoListCardStylesheet.radioBadgeComplete
                      : todoListCardStylesheet.radioBadgeIncomplete,
                  ]}
                >
                  {item.completed ? (
                    <Check size={12} color={unistylesTheme.colors.primaryForeground} />
                  ) : null}
                </View>
                <Text
                  style={[
                    todoListCardStylesheet.itemText,
                    item.completed && todoListCardStylesheet.itemTextCompleted,
                  ]}
                >
                  {item.text}
                </Text>
              </View>
            ))
          )}
        </View>
      </View>
    );
  }, [items]);

  return (
    <ExpandableBadge
      label="Tasks"
      secondaryLabel={nextTask}
      icon={CheckSquare}
      isExpanded={isExpanded}
      onToggle={handleToggle}
      renderDetails={renderDetails}
      disableOuterSpacing={disableOuterSpacing}
    />
  );
});

interface ExpandableBadgeProps {
  label: string;
  secondaryLabel?: string;
  icon?: ComponentType<{ size?: number; color?: string }>;
  isExpanded: boolean;
  style?: StyleProp<ViewStyle>;
  onToggle?: () => void;
  onDetailHoverChange?: (hovered: boolean) => void;
  renderDetails?: () => ReactNode;
  isLoading?: boolean;
  isError?: boolean;
  isLastInSequence?: boolean;
  disableOuterSpacing?: boolean;
  testID?: string;
}

const ExpandableBadge = memo(function ExpandableBadge({
  label,
  style,
  secondaryLabel,
  icon,
  isExpanded,
  onToggle,
  onDetailHoverChange,
  renderDetails,
  isLoading = false,
  isError = false,
  isLastInSequence = false,
  disableOuterSpacing,
  testID,
}: ExpandableBadgeProps) {
  const { theme } = useUnistyles();
  const resolvedDisableOuterSpacing =
    useDisableOuterSpacing(disableOuterSpacing);
  const isInteractive = Boolean(onToggle);
  const hasDetailContent = Boolean(renderDetails);
  const detailContent =
    hasDetailContent && isExpanded ? renderDetails?.() : null;
  const detailWrapperRef = useRef<View | null>(null);
  const wheelInvestigationComponentId = `ExpandableBadgeWheel:${
    testID ?? label
  }`;

  const nativeGradientIdRef = useRef(
    `shimmer-gradient-${Math.random().toString(36).substring(2, 9)}`
  );
  const [labelRowWidth, setLabelRowWidth] = useState(0);
  const [labelRowHeight, setLabelRowHeight] = useState(0);
  const [labelOffsetX, setLabelOffsetX] = useState(0);
  const [labelWidth, setLabelWidth] = useState(0);
  const [secondaryOffsetX, setSecondaryOffsetX] = useState(0);
  const [secondaryWidth, setSecondaryWidth] = useState(0);
  const shimmerTranslateX = useSharedValue(0);

  const totalShimmerChars =
    label.trim().length + (secondaryLabel?.trim().length ?? 0);
  const shortTextDurationAdjustment = totalShimmerChars <= 12 ? 0.25 : 0;
  const shimmerDuration = Math.max(
    1,
    Math.min(2.3, 1.25 + totalShimmerChars * 0.008 - shortTextDurationAdjustment)
  );
  const nativeShimmerPeakWidth = Math.max(
    32,
    Math.min(120, labelRowWidth > 0 ? labelRowWidth * 0.28 : 0)
  );
  const isWebShimmer = isLoading && Platform.OS === "web";
  const shouldMeasureWebShimmer = isWebShimmer;
  const shouldMeasureNativeShimmer = isLoading && Platform.OS !== "web";
  const isNativeShimmer =
    shouldMeasureNativeShimmer &&
    labelRowWidth > 0 &&
    labelRowHeight > 0;
  const webShimmerSpanStartX = labelOffsetX;
  const webShimmerSpanEndX = secondaryLabel
    ? secondaryOffsetX + secondaryWidth
    : labelOffsetX + labelWidth;
  const webShimmerSpanWidth = Math.max(
    1,
    webShimmerSpanEndX - webShimmerSpanStartX
  );
  const webShimmerPeakWidth = Math.max(
    42,
    Math.min(120, webShimmerSpanWidth * 0.22)
  );
  const webShimmerTrackStart = webShimmerSpanStartX - webShimmerPeakWidth;
  const webShimmerTrackEnd = webShimmerSpanEndX;

  const handleLabelRowLayout = useCallback((event: LayoutChangeEvent) => {
    if (!shouldMeasureNativeShimmer) {
      return;
    }
    const { width, height } = event.nativeEvent.layout;
    setLabelRowWidth((previous) =>
      Math.abs(previous - width) > 0.5 ? width : previous
    );
    setLabelRowHeight((previous) =>
      Math.abs(previous - height) > 0.5 ? height : previous
    );
  }, [shouldMeasureNativeShimmer]);

  const handleLabelLayout = useCallback((event: LayoutChangeEvent) => {
    if (!shouldMeasureWebShimmer) {
      return;
    }
    const { x, width } = event.nativeEvent.layout;
    setLabelOffsetX((previous) =>
      Math.abs(previous - x) > 0.5 ? x : previous
    );
    setLabelWidth((previous) =>
      Math.abs(previous - width) > 0.5 ? width : previous
    );
  }, [shouldMeasureWebShimmer]);

  const handleSecondaryLayout = useCallback((event: LayoutChangeEvent) => {
    if (!shouldMeasureWebShimmer || !secondaryLabel) {
      return;
    }
    const { x, width } = event.nativeEvent.layout;
    setSecondaryOffsetX((previous) =>
      Math.abs(previous - x) > 0.5 ? x : previous
    );
    setSecondaryWidth((previous) =>
      Math.abs(previous - width) > 0.5 ? width : previous
    );
  }, [shouldMeasureWebShimmer, secondaryLabel]);

  useEffect(() => {
    if (!isWebShimmer) {
      return;
    }
    ensureWebToolCallShimmerKeyframes();
  }, [isWebShimmer]);

  useEffect(() => {
    if (!isNativeShimmer) {
      cancelAnimation(shimmerTranslateX);
      shimmerTranslateX.value = -nativeShimmerPeakWidth;
      return;
    }
    const startPosition = -nativeShimmerPeakWidth;
    const endPosition = labelRowWidth + nativeShimmerPeakWidth;
    shimmerTranslateX.value = startPosition;
    shimmerTranslateX.value = withRepeat(
      withTiming(endPosition, {
        duration: shimmerDuration * 1000,
        easing: Easing.linear,
      }),
      -1,
      false
    );
    return () => {
      cancelAnimation(shimmerTranslateX);
    };
  }, [
    isNativeShimmer,
    labelRowWidth,
    nativeShimmerPeakWidth,
    shimmerDuration,
    shimmerTranslateX,
  ]);

  useEffect(() => {
    if (Platform.OS !== "web" || !isExpanded || !hasDetailContent) {
      return;
    }

    const node = detailWrapperRef.current as unknown as HTMLElement | null;
    if (!node || typeof node.addEventListener !== "function") {
      return;
    }

    const stopWheelPropagation = (event: WheelEvent) => {
      if (shouldStopDetailWheelPropagation(node, event)) {
        event.stopPropagation();
      }
    };

    markScrollInvestigationEvent(wheelInvestigationComponentId, "wheelAttach");
    node.addEventListener("wheel", stopWheelPropagation, { passive: true });
    return () => {
      markScrollInvestigationEvent(wheelInvestigationComponentId, "wheelDetach");
      node.removeEventListener("wheel", stopWheelPropagation);
    };
  }, [hasDetailContent, isExpanded, wheelInvestigationComponentId]);

  const nativeShimmerPeakStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: shimmerTranslateX.value }],
  }));

  const shimmerGradient =
    "linear-gradient(90deg, rgba(255, 255, 255, 0) 0%, rgba(255, 255, 255, 0.45) 24%, #ffffff 40%, #ffffff 60%, rgba(255, 255, 255, 0.45) 76%, rgba(255, 255, 255, 0) 100%)";

  const shimmerLabelStyle = isWebShimmer
    ? ({
        opacity: 1,
        color: "transparent",
        backgroundImage: shimmerGradient,
        backgroundSize: `${webShimmerPeakWidth}px 100%`,
        backgroundRepeat: "no-repeat",
        backgroundClip: "text",
        WebkitBackgroundClip: "text",
        WebkitTextFillColor: "transparent",
        animation: `${WEB_TOOLCALL_SHIMMER_ANIMATION_NAME} ${shimmerDuration}s linear infinite`,
        "--paseo-shimmer-start": `${webShimmerTrackStart - labelOffsetX}px`,
        "--paseo-shimmer-end": `${webShimmerTrackEnd - labelOffsetX}px`,
      } as never)
    : null;

  const shimmerSecondaryStyle = isWebShimmer
    ? ({
        opacity: 1,
        color: "transparent",
        backgroundImage: shimmerGradient,
        backgroundSize: `${webShimmerPeakWidth}px 100%`,
        backgroundRepeat: "no-repeat",
        backgroundClip: "text",
        WebkitBackgroundClip: "text",
        WebkitTextFillColor: "transparent",
        animation: `${WEB_TOOLCALL_SHIMMER_ANIMATION_NAME} ${shimmerDuration}s linear infinite`,
        "--paseo-shimmer-start": `${webShimmerTrackStart - secondaryOffsetX}px`,
        "--paseo-shimmer-end": `${webShimmerTrackEnd - secondaryOffsetX}px`,
      } as never)
    : null;

  const IconComponent = icon;
  const iconColor = isError
    ? theme.colors.destructive
    : theme.colors.mutedForeground;

  let iconNode: ReactNode = null;
  if (isError) {
    iconNode = <TriangleAlertIcon size={12} color={iconColor} opacity={0.8} />;
  } else if (IconComponent) {
    iconNode = <IconComponent size={12} color={iconColor} />;
  }

  return (
    <View
      style={[
        expandableBadgeStylesheet.container,
        !resolvedDisableOuterSpacing &&
          (isLastInSequence
            ? expandableBadgeStylesheet.containerLastInSequence
            : expandableBadgeStylesheet.containerSpacing),
        style,
      ]}
      testID={testID}
    >
      <Pressable
        onPress={isInteractive ? onToggle : undefined}
        disabled={!isInteractive}
        accessibilityRole={isInteractive ? "button" : undefined}
        accessibilityState={isInteractive ? { expanded: isExpanded } : undefined}
        style={({ pressed }) => [
          expandableBadgeStylesheet.pressable,
          pressed && isInteractive
            ? expandableBadgeStylesheet.pressablePressed
            : null,
          isExpanded && expandableBadgeStylesheet.pressableExpanded,
        ]}
      >
        {({ hovered }) => (
          <>
            <View style={expandableBadgeStylesheet.headerRow}>
              <View style={expandableBadgeStylesheet.iconBadge}>{iconNode}</View>
              <View
                style={expandableBadgeStylesheet.labelRow}
                onLayout={shouldMeasureNativeShimmer ? handleLabelRowLayout : undefined}
              >
                <Text
                  style={[
                    expandableBadgeStylesheet.label,
                    isLoading && expandableBadgeStylesheet.labelLoading,
                  ]}
                  numberOfLines={1}
                  onLayout={shouldMeasureWebShimmer ? handleLabelLayout : undefined}
                >
                  {label}
                </Text>
                {secondaryLabel ? (
                  <Text
                    style={expandableBadgeStylesheet.secondaryLabel}
                    numberOfLines={1}
                    onLayout={shouldMeasureWebShimmer ? handleSecondaryLayout : undefined}
                  >
                    {secondaryLabel}
                  </Text>
                ) : (
                  <View style={expandableBadgeStylesheet.spacer} />
                )}
                {isWebShimmer ? (
                  <View
                    style={expandableBadgeStylesheet.shimmerOverlay}
                    pointerEvents="none"
                  >
                    <Text
                      style={[
                        expandableBadgeStylesheet.label,
                        isLoading && expandableBadgeStylesheet.labelLoading,
                        expandableBadgeStylesheet.shimmerText,
                        shimmerLabelStyle,
                      ]}
                      numberOfLines={1}
                    >
                      {label}
                    </Text>
                    {secondaryLabel ? (
                      <Text
                        style={[
                          expandableBadgeStylesheet.secondaryLabel,
                          expandableBadgeStylesheet.shimmerText,
                          shimmerSecondaryStyle,
                        ]}
                        numberOfLines={1}
                      >
                        {secondaryLabel}
                      </Text>
                    ) : (
                      <View style={expandableBadgeStylesheet.spacer} />
                    )}
                  </View>
                ) : null}
                {isNativeShimmer ? (
                  <View
                    style={expandableBadgeStylesheet.shimmerOverlay}
                    pointerEvents="none"
                  >
                    <MaskedView
                      style={[
                        expandableBadgeStylesheet.nativeShimmerTrack,
                        { width: labelRowWidth, height: labelRowHeight },
                      ]}
                      maskElement={
                        <View
                          style={[
                            expandableBadgeStylesheet.shimmerMaskRow,
                            { width: labelRowWidth, height: labelRowHeight },
                          ]}
                        >
                          <Text
                            style={[
                              expandableBadgeStylesheet.label,
                              { color: "#000000", opacity: 1 },
                            ]}
                            numberOfLines={1}
                          >
                            {label}
                          </Text>
                          {secondaryLabel ? (
                            <Text
                              style={[
                                expandableBadgeStylesheet.secondaryLabel,
                                { color: "#000000", opacity: 1 },
                              ]}
                              numberOfLines={1}
                            >
                              {secondaryLabel}
                            </Text>
                          ) : (
                            <View style={expandableBadgeStylesheet.spacer} />
                          )}
                        </View>
                      }
                    >
                      <View
                        style={[
                          expandableBadgeStylesheet.nativeShimmerTrack,
                          { width: labelRowWidth, height: labelRowHeight },
                        ]}
                      >
                        <Animated.View
                          style={[
                            expandableBadgeStylesheet.nativeShimmerPeak,
                            nativeShimmerPeakStyle,
                            { width: nativeShimmerPeakWidth, height: labelRowHeight },
                          ]}
                        >
                          <Svg width="100%" height="100%" preserveAspectRatio="none">
                            <Defs>
                              <SvgLinearGradient
                                id={nativeGradientIdRef.current}
                                x1="0%"
                                y1="0%"
                                x2="100%"
                                y2="0%"
                              >
                                <Stop offset="0%" stopColor="#ffffff" stopOpacity={0} />
                                <Stop offset="50%" stopColor="#ffffff" stopOpacity={1} />
                                <Stop offset="100%" stopColor="#ffffff" stopOpacity={0} />
                              </SvgLinearGradient>
                            </Defs>
                            <Rect
                              x="0"
                              y="0"
                              width="100%"
                              height="100%"
                              fill={`url(#${nativeGradientIdRef.current})`}
                            />
                          </Svg>
                        </Animated.View>
                      </View>
                    </MaskedView>
                  </View>
                ) : null}
              </View>
              {isInteractive && hovered ? (
                <ChevronRight
                  size={14}
                  color={theme.colors.foregroundMuted}
                  style={[
                    expandableBadgeStylesheet.chevron,
                    { transform: [{ rotate: isExpanded ? "90deg" : "0deg" }] },
                  ]}
                />
              ) : null}
            </View>
          </>
        )}
      </Pressable>
      {detailContent ? (
        <Pressable
          ref={detailWrapperRef}
          style={expandableBadgeStylesheet.detailWrapper}
          onHoverIn={() => onDetailHoverChange?.(true)}
          onHoverOut={() => onDetailHoverChange?.(false)}
        >
          {detailContent}
        </Pressable>
      ) : null}
    </View>
  );
}, areExpandableBadgePropsEqual);

function areExpandableBadgePropsEqual(
  previous: ExpandableBadgeProps,
  next: ExpandableBadgeProps
) {
  if (previous.label !== next.label) return false;
  if (previous.secondaryLabel !== next.secondaryLabel) return false;
  if (previous.icon !== next.icon) return false;
  if (previous.isExpanded !== next.isExpanded) return false;
  if (previous.style !== next.style) return false;
  if (previous.isLoading !== next.isLoading) return false;
  if (previous.isError !== next.isError) return false;
  if (previous.isLastInSequence !== next.isLastInSequence) return false;
  if (previous.disableOuterSpacing !== next.disableOuterSpacing) return false;
  if (previous.testID !== next.testID) return false;
  if (Boolean(previous.onToggle) !== Boolean(next.onToggle)) return false;
  if (previous.isExpanded && previous.renderDetails !== next.renderDetails) {
    return false;
  }
  return true;
}

interface ToolCallProps {
  toolName: string;
  args?: unknown | null;
  result?: unknown | null;
  error?: unknown | null;
  status: "executing" | "running" | "completed" | "failed" | "canceled";
  detail?: ToolCallDetail;
  cwd?: string;
  metadata?: Record<string, unknown>;
  isLastInSequence?: boolean;
  disableOuterSpacing?: boolean;
  onInlineDetailsHoverChange?: (hovered: boolean) => void;
  onInlineDetailsExpandedChange?: (expanded: boolean) => void;
}

const TOOL_CALL_LOG_TAG = "[ToolCall]";
const TOOL_CALL_COMMIT_THRESHOLD_MS = 16;


export const ToolCall = memo(function ToolCall({
  toolName,
  args,
  result,
  error,
  status,
  detail,
  cwd,
  metadata,
  isLastInSequence = false,
  disableOuterSpacing,
  onInlineDetailsHoverChange,
  onInlineDetailsExpandedChange,
}: ToolCallProps) {
  const { openToolCall } = useToolCallSheet();
  const [isExpanded, setIsExpanded] = useState(false);
  const toggleStartRef = useRef<number | null>(null);

  // Check if we're on mobile (use bottom sheet) or desktop (inline expand)
  const isMobile =
    UnistylesRuntime.breakpoint === "xs" ||
    UnistylesRuntime.breakpoint === "sm";

  const effectiveDetail = useMemo<ToolCallDetail | undefined>(() => {
    if (detail) {
      return detail;
    }
    if (args !== undefined || result !== undefined) {
      return {
        type: "unknown",
        input: args ?? null,
        output: result ?? null,
      };
    }
    return undefined;
  }, [detail, args, result]);

  const displayDetail =
    effectiveDetail ?? {
      type: "unknown",
      input: null,
      output: null,
    };

  const displayModel = useMemo(
    () =>
      buildToolCallDisplayModel({
        name: toolName,
        status: status === "executing" ? "running" : status,
        error: error ?? null,
        detail: displayDetail,
        metadata,
        cwd,
      }),
    [toolName, status, error, displayDetail, metadata, cwd]
  );
  const displayName = displayModel.displayName;
  const summary = displayModel.summary;
  const errorText = displayModel.errorText;
  const iconCategory = effectiveDetail?.type ?? toolName.trim().toLowerCase();
  const IconComponent = resolveToolCallIcon(toolName, effectiveDetail);

  // Check if there's any content to display
  const hasDetails =
    Boolean(error) ||
    (effectiveDetail
      ? effectiveDetail.type !== "unknown" ||
        effectiveDetail.input !== null ||
        effectiveDetail.output !== null
      : false);

  const handleToggle = useCallback(() => {
    if (!isMobile && isPerfLoggingEnabled()) {
      toggleStartRef.current = getNowMs();
    }
    if (isMobile) {
      openToolCall({
        toolName,
        displayName,
        summary,
        detail: effectiveDetail,
        errorText,
      });
    } else {
      setIsExpanded((prev) => !prev);
    }
  }, [isMobile, openToolCall, toolName, displayName, summary, effectiveDetail, errorText]);

  useEffect(() => {
    if (isMobile || !isPerfLoggingEnabled()) {
      return;
    }
    const startMs = toggleStartRef.current;
    if (startMs === null) {
      return;
    }
    toggleStartRef.current = null;
    const logCommit = () => {
      const durationMs = getNowMs() - startMs;
      if (durationMs >= TOOL_CALL_COMMIT_THRESHOLD_MS) {
        perfLog(TOOL_CALL_LOG_TAG, {
          event: isExpanded ? "expand_commit" : "collapse_commit",
          toolName,
          iconCategory,
          durationMs: Math.round(durationMs),
        });
      }
    };
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => logCommit());
    } else {
      logCommit();
    }
  }, [isExpanded, isMobile, toolName, iconCategory]);

  useEffect(() => {
    if (!onInlineDetailsHoverChange || isMobile || isExpanded) {
      return;
    }
    onInlineDetailsHoverChange(false);
  }, [isExpanded, isMobile, onInlineDetailsHoverChange]);

  useEffect(() => {
    if (!onInlineDetailsExpandedChange) {
      return;
    }
    if (isMobile) {
      onInlineDetailsExpandedChange(false);
      return;
    }
    onInlineDetailsExpandedChange(isExpanded);
  }, [isExpanded, isMobile, onInlineDetailsExpandedChange]);

  useEffect(() => {
    if (!onInlineDetailsExpandedChange) {
      return;
    }
    return () => {
      onInlineDetailsExpandedChange(false);
    };
  }, [onInlineDetailsExpandedChange]);

  // Render inline details for desktop
  const renderDetails = useCallback(() => {
    if (isMobile) return null;
    return (
      <ToolCallDetailsContent
        detail={effectiveDetail}
        errorText={errorText}
        maxHeight={400}
      />
    );
  }, [isMobile, effectiveDetail, errorText]);

  return (
    <ExpandableBadge
      testID="tool-call-badge"
      label={displayName}
      secondaryLabel={summary}
      icon={IconComponent}
      isExpanded={!isMobile && isExpanded}
      onToggle={hasDetails ? handleToggle : undefined}
      renderDetails={hasDetails && !isMobile ? renderDetails : undefined}
      isLoading={status === "running" || status === "executing"}
      isError={status === "failed"}
      isLastInSequence={isLastInSequence}
      disableOuterSpacing={disableOuterSpacing}
      onDetailHoverChange={onInlineDetailsHoverChange}
    />
  );
}, areToolCallPropsEqual);

function areToolCallPropsEqual(previous: ToolCallProps, next: ToolCallProps) {
  if (previous.toolName !== next.toolName) return false;
  if (previous.args !== next.args) return false;
  if (previous.result !== next.result) return false;
  if (previous.error !== next.error) return false;
  if (previous.status !== next.status) return false;
  if (previous.detail !== next.detail) return false;
  if (previous.cwd !== next.cwd) return false;
  if (previous.metadata !== next.metadata) return false;
  if (previous.isLastInSequence !== next.isLastInSequence) return false;
  if (previous.disableOuterSpacing !== next.disableOuterSpacing) return false;
  return true;
}
