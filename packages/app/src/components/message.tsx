import {
  View,
  Text,
  Image,
  Pressable,
  ActivityIndicator,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  StyleProp,
  ViewStyle,
  type TextStyle,
} from "react-native";
import * as React from "react";
import {
  useState,
  useEffect,
  useRef,
  memo,
  useMemo,
  useCallback,
  createContext,
  useContext,
  isValidElement,
  Children,
  cloneElement,
} from "react";
import type { ReactNode, ComponentType } from "react";
import Markdown, {
  MarkdownIt,
  type ASTNode,
  type RenderRules,
} from "react-native-markdown-display";
import { useQuery } from "@tanstack/react-query";
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
  Copy,
  TriangleAlertIcon,
  Scissors,
  MicVocal,
  FileSymlink,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { useIsCompactFormFactor } from "@/constants/layout";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, { Defs, LinearGradient as SvgLinearGradient, Rect, Stop } from "react-native-svg";
import { createMarkdownStyles } from "@/styles/markdown-styles";
import { Fonts } from "@/constants/theme";
import * as Clipboard from "expo-clipboard";
import type { TodoEntry, UserMessageImageAttachment } from "@/types/stream";
import type { AgentAttachment } from "@server/shared/messages";
import type { ToolCallDetail } from "@server/server/agent/agent-sdk-types";
import { buildToolCallDisplayModel } from "@/utils/tool-call-display";
import { resolveToolCallIcon } from "@/utils/tool-call-icon";
import { extractToolCallFilePath } from "@/utils/extract-tool-call-file-path";
import {
  hasMeaningfulToolCallDetail,
  isPendingToolCallDetail,
} from "@/utils/tool-call-detail-state";
import {
  parseAssistantFileLink,
  parseInlinePathToken,
  type InlinePathTarget,
} from "@/utils/inline-path";
import { getMarkdownListMarker } from "@/utils/markdown-list";
import { openExternalUrl } from "@/utils/open-external-url";
import { splitMarkdownBlocks } from "@/utils/split-markdown-blocks";
import {
  getAssistantImageLoadStateFromMetadata,
  getAssistantImageMetadata,
  setAssistantImageMetadata,
  type AssistantImageLoadState,
} from "@/utils/assistant-image-metadata";
import { setAssistantMarkdownBlockHeight } from "@/utils/assistant-message-height-estimate";
import { resolveAssistantImageSource } from "@/utils/assistant-image-source";
import {
  createPreviewAttachmentId,
  getFileNameFromPath,
  parseImageDataUrl,
} from "@/attachments/utils";
import { PlanCard } from "./plan-card";
import { useToolCallSheet } from "./tool-call-sheet";
import { ToolCallDetailsContent } from "./tool-call-details";
import { useAttachmentPreviewUrl } from "@/attachments/use-attachment-preview-url";
import { persistAttachmentFromBytes, persistAttachmentFromDataUrl } from "@/attachments/service";
import type { DaemonClient } from "@server/client/daemon-client";
import { isWeb, isNative } from "@/constants/platform";
export type { InlinePathTarget } from "@/utils/inline-path";

type MarkdownStyles = Record<string, TextStyle & ViewStyle & { [key: string]: unknown }>;

interface UserMessageProps {
  message: string;
  images?: UserMessageImageAttachment[];
  attachments?: AgentAttachment[];
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
const MARKDOWN_ALLOWED_IMAGE_HANDLERS = [
  "data:image/png;base64",
  "data:image/gif;base64",
  "data:image/jpeg;base64",
  "https://",
  "http://",
] as const;
const MARKDOWN_TOP_LEVEL_MAX_EXCEEDED_ITEM = <Text key="dotdotdot">...</Text>;

interface MarkdownWithStableRendererProps {
  children: ReactNode;
  style: ReturnType<typeof createMarkdownStyles>;
  rules: RenderRules;
  markdownit: MarkdownIt;
  onLinkPress: (url: string) => boolean;
  allowedImageHandlers: readonly string[];
  topLevelMaxExceededItem: ReactNode;
}

const MarkdownWithStableRenderer = Markdown as ComponentType<MarkdownWithStableRendererProps>;
const ThemedMarkdown = withUnistyles(MarkdownWithStableRenderer);
const markdownStyleMapping = (theme: Theme): Partial<MarkdownWithStableRendererProps> => ({
  style: createMarkdownStyles(theme),
});

const ThemedMicVocal = withUnistyles(MicVocal);
const ThemedTodoCheckIcon = withUnistyles(Check);
const ThemedFileSymlinkIcon = withUnistyles(FileSymlink);
const ThemedTriangleAlertIcon = withUnistyles(TriangleAlertIcon);
const ThemedChevronRightIcon = withUnistyles(ChevronRight);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const mutedForegroundColorMapping = (theme: Theme) => ({
  color: theme.colors.mutedForeground,
});
const primaryForegroundColorMapping = (theme: Theme) => ({
  color: theme.colors.primaryForeground,
});
const destructiveColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });
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
  if (isNative) {
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

function getWheelEventElementTarget(event: WheelEvent, fallback: HTMLElement): HTMLElement {
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
  delta: number,
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
    axis === "x"
      ? element.scrollWidth - element.clientWidth
      : element.scrollHeight - element.clientHeight;
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
  delta: number,
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

function shouldStopDetailWheelPropagation(detailRoot: HTMLElement, event: WheelEvent): boolean {
  const startElement = getWheelEventElementTarget(event, detailRoot);
  const verticalDelta = event.deltaY;
  let horizontalDelta: number;
  if (event.deltaX !== 0) horizontalDelta = event.deltaX;
  else if (event.shiftKey) horizontalDelta = event.deltaY;
  else horizontalDelta = 0;

  const hasVerticalIntent = Math.abs(verticalDelta) > SCROLL_EDGE_EPSILON;
  const hasHorizontalIntent = Math.abs(horizontalDelta) > SCROLL_EDGE_EPSILON;
  if (!hasVerticalIntent && !hasHorizontalIntent) {
    return false;
  }

  const canScrollVertically = hasVerticalIntent
    ? canScrollInsideDetailFromTarget(detailRoot, startElement, "y", verticalDelta)
    : false;
  const canScrollHorizontally = hasHorizontalIntent
    ? canScrollInsideDetailFromTarget(detailRoot, startElement, "x", horizontalDelta)
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
    ...(isWeb ? { userSelect: "text" as const } : {}),
  },
  content: {
    alignItems: "flex-end",
    maxWidth: "100%",
    cursor: "auto",
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
  attachmentPreviewContainer: {
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
  structuredAttachmentPill: {
    maxWidth: 220,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  structuredAttachmentText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
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

function UserMessageAttachmentThumbnail({ image }: { image: UserMessageImageAttachment }) {
  const uri = useAttachmentPreviewUrl(image);
  const imageSource = useMemo(() => ({ uri: uri ?? "" }), [uri]);
  if (!uri) {
    return <View style={userMessageStylesheet.imageThumbnailPlaceholder} />;
  }
  return <Image source={imageSource} style={userMessageStylesheet.imageThumbnail} />;
}

function getUserMessageAttachmentLabel(attachment: AgentAttachment): string {
  switch (attachment.type) {
    case "review": {
      const count = attachment.comments.length;
      return count === 1 ? "Review · 1 comment" : `Review · ${count} comments`;
    }
    case "github_pr":
      return `PR #${attachment.number}`;
    case "github_issue":
      return `Issue #${attachment.number}`;
    case "text":
      return attachment.title ?? "Text attachment";
    default:
      return "";
  }
}

export const UserMessage = memo(function UserMessage({
  message,
  images = [],
  attachments = [],
  timestamp: _timestamp,
  isFirstInGroup = true,
  isLastInGroup = true,
  disableOuterSpacing,
}: UserMessageProps) {
  const isCompact = useIsCompactFormFactor();
  const [messageHovered, setMessageHovered] = useState(false);
  const [copyButtonHovered, setCopyButtonHovered] = useState(false);
  const resolvedDisableOuterSpacing = useDisableOuterSpacing(disableOuterSpacing);
  const hasText = message.trim().length > 0;
  const hasImages = images.length > 0;
  const hasAttachments = attachments.length > 0;
  const showCopyButton = hasText && (isCompact || messageHovered || copyButtonHovered);

  const handleHoverIn = useCallback(() => setMessageHovered(true), []);
  const handleHoverOut = useCallback(() => setMessageHovered(false), []);
  const getMessageContent = useCallback(() => message, [message]);

  const containerStyle = useMemo(
    () => [
      userMessageStylesheet.container,
      !resolvedDisableOuterSpacing && [
        isFirstInGroup ? userMessageStylesheet.containerFirstInGroup : null,
        isLastInGroup ? userMessageStylesheet.containerLastInGroup : null,
        !isFirstInGroup || !isLastInGroup ? userMessageStylesheet.containerSpacing : null,
      ],
    ],
    [resolvedDisableOuterSpacing, isFirstInGroup, isLastInGroup],
  );
  const imagePreviewContainerStyle = useMemo(
    () => [
      userMessageStylesheet.imagePreviewContainer,
      hasText || hasAttachments ? userMessageStylesheet.imagePreviewSpacing : undefined,
    ],
    [hasAttachments, hasText],
  );
  const attachmentPreviewContainerStyle = useMemo(
    () => [
      userMessageStylesheet.attachmentPreviewContainer,
      hasText ? userMessageStylesheet.imagePreviewSpacing : undefined,
    ],
    [hasText],
  );
  const copyButtonStyle = useMemo(
    () => [
      userMessageStylesheet.copyButton,
      showCopyButton
        ? userMessageStylesheet.copyButtonVisible
        : userMessageStylesheet.copyButtonHidden,
    ],
    [showCopyButton],
  );

  return (
    <View style={containerStyle}>
      <Pressable
        style={userMessageStylesheet.content}
        onHoverIn={handleHoverIn}
        onHoverOut={handleHoverOut}
      >
        <View style={userMessageStylesheet.bubble}>
          {hasImages ? (
            <View style={imagePreviewContainerStyle}>
              {images.map((image) => (
                <View key={image.id} style={userMessageStylesheet.imagePill}>
                  <UserMessageAttachmentThumbnail image={image} />
                </View>
              ))}
            </View>
          ) : null}
          {hasAttachments ? (
            <View style={attachmentPreviewContainerStyle}>
              {attachments.map((attachment, index) => (
                <View
                  key={`${attachment.type}:${"number" in attachment ? attachment.number : index}`}
                  style={userMessageStylesheet.structuredAttachmentPill}
                >
                  <Text style={userMessageStylesheet.structuredAttachmentText} numberOfLines={1}>
                    {getUserMessageAttachmentLabel(attachment)}
                  </Text>
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
            getContent={getMessageContent}
            containerStyle={copyButtonStyle}
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
  workspaceRoot?: string;
  serverId?: string;
  client?: DaemonClient | null;
  disableOuterSpacing?: boolean;
  spacing?: "default" | "compactTop" | "compactBottom" | "compactBoth";
}

export const assistantMessageStylesheet = StyleSheet.create((theme) => ({
  container: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[3],
    ...(isWeb ? { userSelect: "text" as const } : {}),
  },
  containerCompactTop: {
    paddingTop: 0,
  },
  containerCompactBottom: {
    paddingBottom: 0,
  },
  containerSpacing: {
    marginBottom: theme.spacing[4],
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
    userSelect: isWeb ? "text" : "auto",
  },
  imageFrame: {
    width: "100%",
    minHeight: 160,
    marginHorizontal: -theme.spacing[1],
  },
  imageSurface: {
    width: "100%",
    overflow: "hidden",
  },
  image: {
    width: "100%",
    height: "100%",
  },
  imageState: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[6],
    gap: theme.spacing[2],
  },
  imageErrorText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));

const ASSISTANT_IMAGE_MIN_HEIGHT = 160;

const AssistantMarkdownResolvedImage = memo(function AssistantMarkdownResolvedImage({
  uri,
  alt,
  containerStyle,
  source,
  workspaceRoot,
  serverId,
}: {
  uri: string;
  alt?: string;
  containerStyle?: StyleProp<ViewStyle>;
  source: string;
  workspaceRoot?: string;
  serverId?: string;
}) {
  const cachedMetadata = useMemo(
    () => getAssistantImageMetadata({ source, workspaceRoot, serverId }),
    [serverId, source, workspaceRoot],
  );
  const [loadState, setLoadState] = useState<AssistantImageLoadState>(() =>
    getAssistantImageLoadStateFromMetadata(cachedMetadata),
  );

  useEffect(() => {
    if (cachedMetadata) {
      setLoadState(getAssistantImageLoadStateFromMetadata(cachedMetadata));
      return () => {};
    }

    setLoadState({ status: "loading" });
    let cancelled = false;

    Image.getSize(
      uri,
      (width, height) => {
        if (cancelled) {
          return;
        }
        if (width > 0 && height > 0) {
          const metadata = setAssistantImageMetadata(
            { source, workspaceRoot, serverId },
            { width, height },
          );
          setLoadState({
            status: "ready",
            aspectRatio: metadata?.aspectRatio ?? width / height,
          });
        }
      },
      () => {
        if (cancelled) {
          return;
        }
        setLoadState({ status: "error" });
      },
    );

    return () => {
      cancelled = true;
    };
  }, [cachedMetadata, serverId, source, uri, workspaceRoot]);

  const handleImageError = useCallback(() => {
    setLoadState({ status: "error" });
  }, []);
  const surfaceStyle = useMemo<StyleProp<ViewStyle>>(
    () => [
      assistantMessageStylesheet.imageSurface,
      loadState.status === "ready"
        ? { aspectRatio: loadState.aspectRatio }
        : { height: ASSISTANT_IMAGE_MIN_HEIGHT },
    ],
    [loadState],
  );
  const frameStyle = useMemo<StyleProp<ViewStyle>>(
    () => [assistantMessageStylesheet.imageFrame, containerStyle],
    [containerStyle],
  );
  const stateSurfaceStyle = useMemo<StyleProp<ViewStyle>>(
    () => [surfaceStyle, assistantMessageStylesheet.imageState],
    [surfaceStyle],
  );
  const imageSource = useMemo(() => ({ uri }), [uri]);

  if (loadState.status !== "ready") {
    return (
      <View style={frameStyle}>
        <View style={stateSurfaceStyle}>
          {loadState.status === "loading" ? <ActivityIndicator size="small" /> : null}
          {loadState.status === "error" ? (
            <Text style={assistantMessageStylesheet.imageErrorText}>Image unavailable</Text>
          ) : null}
        </View>
      </View>
    );
  }

  return (
    <View style={frameStyle}>
      <View style={surfaceStyle}>
        <Image
          source={imageSource}
          style={assistantMessageStylesheet.image}
          resizeMode="contain"
          accessibilityLabel={alt}
          onError={handleImageError}
        />
      </View>
    </View>
  );
});

function AssistantMarkdownImage({
  source,
  alt,
  hasLeadingContent,
  client,
  workspaceRoot,
  serverId,
}: {
  source: string;
  alt?: string;
  hasLeadingContent: boolean;
  client?: DaemonClient | null;
  workspaceRoot?: string;
  serverId?: string;
}) {
  const resolution = useMemo(
    () => resolveAssistantImageSource({ source, workspaceRoot }),
    [source, workspaceRoot],
  );
  const dataImage = useMemo(() => parseImageDataUrl(source), [source]);
  const containerStyle = useMemo<StyleProp<ViewStyle>>(
    () => ({
      marginTop: hasLeadingContent ? 16 : 0,
      marginBottom: 0,
    }),
    [hasLeadingContent],
  );

  const query = useQuery({
    queryKey: [
      "assistantMarkdownImage",
      serverId ?? "unknown-server",
      resolution?.kind === "file_rpc" ? resolution.cwd : null,
      resolution?.kind === "file_rpc" ? resolution.path : null,
    ],
    enabled: Boolean(client && resolution?.kind === "file_rpc"),
    staleTime: 30_000,
    queryFn: async () => {
      if (!client || !resolution || resolution.kind !== "file_rpc") {
        return null;
      }

      const file = await client.readFile(resolution.cwd, resolution.path);
      if (file.kind !== "image") {
        throw new Error("Image preview unavailable.");
      }

      return await persistAttachmentFromBytes({
        id: createPreviewAttachmentId({
          mimeType: file.mime,
          path: file.path || resolution.path,
          size: file.size,
          modifiedAt: file.modifiedAt,
          contentLength: file.bytes.byteLength,
        }),
        bytes: file.bytes,
        mimeType: file.mime,
        fileName: getFileNameFromPath(file.path || resolution.path),
      });
    },
  });
  const dataImageQuery = useQuery({
    queryKey: ["assistantMarkdownDataImage", dataImage?.cacheKey ?? null],
    enabled: dataImage !== null,
    staleTime: 30_000,
    queryFn: async () => {
      if (!dataImage) {
        return null;
      }

      return await persistAttachmentFromDataUrl({
        id: createPreviewAttachmentId({
          mimeType: dataImage.mimeType,
          contentLength: dataImage.base64.length,
        }),
        dataUrl: source,
        mimeType: dataImage.mimeType,
      });
    },
  });

  const fileAssetUri = useAttachmentPreviewUrl(query.data);
  const dataImageAssetUri = useAttachmentPreviewUrl(dataImageQuery.data);
  const directUri = resolution?.kind === "direct" && !dataImage ? resolution.uri : null;
  const resolvedUri = directUri ?? dataImageAssetUri ?? fileAssetUri ?? null;

  const stateFrameStyle = useMemo<StyleProp<ViewStyle>>(
    () => [
      assistantMessageStylesheet.imageFrame,
      containerStyle,
      { height: ASSISTANT_IMAGE_MIN_HEIGHT },
      assistantMessageStylesheet.imageState,
    ],
    [containerStyle],
  );

  if (resolvedUri) {
    return (
      <AssistantMarkdownResolvedImage
        uri={resolvedUri}
        alt={alt}
        containerStyle={containerStyle}
        source={source}
        workspaceRoot={workspaceRoot}
        serverId={serverId}
      />
    );
  }

  if (query.isLoading || dataImageQuery.isLoading) {
    return (
      <View style={stateFrameStyle}>
        <ActivityIndicator size="small" />
      </View>
    );
  }

  const errorText = resolveAssistantImageErrorText(query.error, dataImageQuery.error);

  return (
    <View style={stateFrameStyle}>
      <Text style={assistantMessageStylesheet.imageErrorText}>{errorText}</Text>
    </View>
  );
}

function resolveAssistantImageErrorText(fileError: unknown, dataError: unknown): string {
  if (fileError instanceof Error) return fileError.message;
  if (dataError instanceof Error) return dataError.message;
  return "Unable to load image preview.";
}

interface InlinePathChipProps {
  content: string;
  parsed: InlinePathTarget;
  onPress: (target: InlinePathTarget) => void;
}

const INLINE_PATH_CHIP_STYLE = [
  assistantMessageStylesheet.pathChip,
  assistantMessageStylesheet.pathChipText,
];

function InlinePathChip({ content, parsed, onPress }: InlinePathChipProps) {
  const handlePress = useCallback(() => onPress(parsed), [onPress, parsed]);
  return (
    <Text
      onPress={handlePress}
      selectable={isWeb ? undefined : false}
      style={INLINE_PATH_CHIP_STYLE}
    >
      {content}
    </Text>
  );
}

function MarkdownLink({
  href,
  style,
  onPress,
  children,
}: {
  href: string;
  style: StyleProp<TextStyle>;
  onPress: (url: string) => void;
  children: ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  const handlePress = useCallback(() => onPress(href), [onPress, href]);
  const handleHoverIn = useCallback(() => setHovered(true), []);
  const handleHoverOut = useCallback(() => setHovered(false), []);
  const hoveredTextStyle = useMemo<StyleProp<TextStyle>>(
    () => [style, hovered && { textDecorationLine: "underline" as const }],
    [style, hovered],
  );
  if (isNative) {
    return (
      <Text accessibilityRole="link" onPress={handlePress} style={style}>
        {children}
      </Text>
    );
  }

  return (
    <a
      href={href}
      onClickCapture={preventAnchorNavigation}
      onAuxClickCapture={preventAnchorNavigation}
      style={MARKDOWN_LINK_ANCHOR_STYLE}
    >
      <Pressable
        accessibilityRole="link"
        onPress={handlePress}
        onHoverIn={handleHoverIn}
        onHoverOut={handleHoverOut}
      >
        <Text style={hoveredTextStyle}>{children}</Text>
      </Pressable>
    </a>
  );
}

const MARKDOWN_LINK_ANCHOR_STYLE: React.CSSProperties = {
  display: "contents",
  color: "inherit",
  textDecoration: "none",
};

function preventAnchorNavigation(event: React.MouseEvent<HTMLAnchorElement>): void {
  event.preventDefault();
}

function getInlineCodeAutoLinkUrl(
  markdownParser: ReturnType<typeof MarkdownIt>,
  content: string,
): string | null {
  const trimmed = content.trim();
  if (!trimmed) {
    return null;
  }

  const matches: Array<{
    index: number;
    lastIndex: number;
    url: string;
  }> | null = markdownParser.linkify.match(trimmed);
  if (!matches || matches.length !== 1) {
    return null;
  }

  const [match] = matches;
  if (!match || match.index !== 0 || match.lastIndex !== trimmed.length) {
    return null;
  }

  return match.url;
}

function nodeHasParentType(parent: unknown, type: string): boolean {
  if (Array.isArray(parent)) {
    return parent.some((entry) => entry?.type === type);
  }

  return (
    typeof parent === "object" &&
    parent !== null &&
    "type" in parent &&
    (parent as Record<"type", unknown>)["type"] === type
  );
}

const turnCopyButtonStylesheet = StyleSheet.create((theme) => ({
  container: {
    alignSelf: "flex-start",
    padding: theme.spacing[2],
    paddingTop: 0,
    marginTop: theme.spacing[2],
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

  const handleHoverIn = useCallback(() => onHoverChange?.(true), [onHoverChange]);
  const handleHoverOut = useCallback(() => onHoverChange?.(false), [onHoverChange]);
  const pressableStyle = useMemo(
    () => [turnCopyButtonStylesheet.container, containerStyle],
    [containerStyle],
  );

  return (
    <Pressable
      onPress={handleCopy}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      style={pressableStyle}
      accessibilityRole="button"
      accessibilityLabel={
        copied ? (copiedAccessibilityLabel ?? "Copied") : (accessibilityLabel ?? "Copy turn")
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
    marginHorizontal: -6,
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
    borderColor: "transparent",
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
    marginRight: theme.spacing[1],
    backgroundColor: "transparent",
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    flexShrink: 0,
  },
  labelActive: {
    color: theme.colors.foreground,
  },
  labelLoading: {
    color: theme.colors.foreground,
    opacity: 0.72,
  },
  secondaryLabel: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    marginLeft: theme.spacing[2],
  },
  secondaryLabelActive: {
    color: theme.colors.foreground,
  },
  shimmerText: {
    color: "transparent",
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  spacer: {
    flex: 1,
  },
  chevron: {
    marginLeft: theme.spacing[1],
    flexShrink: 0,
  },
  openFileButton: {
    marginLeft: theme.spacing[1],
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    flexShrink: 0,
  },
  openFileButtonPlaceholderIcon: {
    width: 14,
    height: 14,
  },
  chevronExpanded: {
    transform: [{ rotate: "90deg" }],
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
    ...(isWeb ? { cursor: "auto" as const, userSelect: "text" as const } : {}),
  },
  pressableExpanded: {
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
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

interface NativeExpandableBadgeShimmerProps {
  label: string;
  secondaryLabel?: string;
  rowWidth: number;
  rowHeight: number;
  peakWidth: number;
  durationSeconds: number;
  gradientId: string;
}

const NativeExpandableBadgeShimmer = memo(function NativeExpandableBadgeShimmer({
  label,
  secondaryLabel,
  rowWidth,
  rowHeight,
  peakWidth,
  durationSeconds,
  gradientId,
}: NativeExpandableBadgeShimmerProps) {
  const shimmerTranslateX = useSharedValue(0);

  useEffect(() => {
    const startPosition = -peakWidth;
    const endPosition = rowWidth + peakWidth;
    shimmerTranslateX.value = startPosition;
    shimmerTranslateX.value = withRepeat(
      withTiming(endPosition, {
        duration: durationSeconds * 1000,
        easing: Easing.linear,
      }),
      -1,
      false,
    );
    return () => {
      cancelAnimation(shimmerTranslateX);
    };
  }, [durationSeconds, peakWidth, rowWidth, shimmerTranslateX]);

  const nativeShimmerPeakStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: shimmerTranslateX.value }],
  }));

  const nativeShimmerTrackStyle = useMemo(
    () => [expandableBadgeStylesheet.nativeShimmerTrack, { width: rowWidth, height: rowHeight }],
    [rowHeight, rowWidth],
  );

  const nativeShimmerMaskStyle = useMemo(
    () => [expandableBadgeStylesheet.shimmerMaskRow, { width: rowWidth, height: rowHeight }],
    [rowHeight, rowWidth],
  );

  const nativeLabelMaskStyle = useMemo(
    () => [expandableBadgeStylesheet.label, { color: "#000000", opacity: 1 }],
    [],
  );

  const nativeSecondaryMaskStyle = useMemo(
    () => [expandableBadgeStylesheet.secondaryLabel, { color: "#000000", opacity: 1 }],
    [],
  );

  const nativeShimmerPeakCombinedStyle = useMemo(
    () => [
      expandableBadgeStylesheet.nativeShimmerPeak,
      nativeShimmerPeakStyle,
      { width: peakWidth, height: rowHeight },
    ],
    [nativeShimmerPeakStyle, peakWidth, rowHeight],
  );

  const maskElement = useMemo(
    () => (
      <View pointerEvents="none" style={nativeShimmerMaskStyle}>
        <Text style={nativeLabelMaskStyle} numberOfLines={1}>
          {label}
        </Text>
        {secondaryLabel ? (
          <Text style={nativeSecondaryMaskStyle} numberOfLines={1}>
            {secondaryLabel}
          </Text>
        ) : (
          <View style={expandableBadgeStylesheet.spacer} />
        )}
      </View>
    ),
    [nativeShimmerMaskStyle, nativeLabelMaskStyle, nativeSecondaryMaskStyle, label, secondaryLabel],
  );

  return (
    <View style={expandableBadgeStylesheet.shimmerOverlay} pointerEvents="none">
      <MaskedView pointerEvents="none" style={nativeShimmerTrackStyle} maskElement={maskElement}>
        <View pointerEvents="none" style={nativeShimmerTrackStyle}>
          <Animated.View pointerEvents="none" style={nativeShimmerPeakCombinedStyle}>
            <NativeShimmerPeakSvg gradientId={gradientId} />
          </Animated.View>
        </View>
      </MaskedView>
    </View>
  );
});

function NativeShimmerPeakSvg({ gradientId }: { gradientId: string }) {
  return (
    <Svg width="100%" height="100%" preserveAspectRatio="none">
      <Defs>
        <SvgLinearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
          <Stop offset="0%" stopColor="#ffffff" stopOpacity={0} />
          <Stop offset="50%" stopColor="#ffffff" stopOpacity={1} />
          <Stop offset="100%" stopColor="#ffffff" stopOpacity={0} />
        </SvgLinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${gradientId})`} />
    </Svg>
  );
}

interface AssistantMessageBlockContainerProps {
  block: string;
  marginBottom: number;
  children: ReactNode;
}

function AssistantMessageBlockContainer({
  block,
  marginBottom,
  children,
}: AssistantMessageBlockContainerProps) {
  const style = useMemo(() => (marginBottom > 0 ? { marginBottom } : undefined), [marginBottom]);
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { width, height } = event.nativeEvent.layout;
      setAssistantMarkdownBlockHeight({ block, width, height });
    },
    [block],
  );
  return (
    <View style={style} onLayout={isWeb ? handleLayout : undefined}>
      {children}
    </View>
  );
}

interface MemoizedMarkdownBlockProps {
  text: string;
  rules: RenderRules;
  parser: MarkdownIt;
  onLinkPress: (url: string) => boolean;
}

const MemoizedMarkdownBlock = React.memo(function MemoizedMarkdownBlock({
  text,
  rules,
  parser,
  onLinkPress,
}: MemoizedMarkdownBlockProps) {
  return (
    <ThemedMarkdown
      uniProps={markdownStyleMapping}
      rules={rules}
      markdownit={parser}
      onLinkPress={onLinkPress}
      allowedImageHandlers={MARKDOWN_ALLOWED_IMAGE_HANDLERS}
      topLevelMaxExceededItem={MARKDOWN_TOP_LEVEL_MAX_EXCEEDED_ITEM}
    >
      {text}
    </ThemedMarkdown>
  );
});

interface MarkdownInheritedTextProps {
  inheritedStyles: TextStyle;
  textStyle: TextStyle;
  style?: StyleProp<TextStyle>;
  children: ReactNode;
}

function MarkdownInheritedText({
  inheritedStyles,
  textStyle,
  style: overrideStyle,
  children,
}: MarkdownInheritedTextProps) {
  const style = useMemo(
    () => [inheritedStyles, textStyle, overrideStyle],
    [inheritedStyles, textStyle, overrideStyle],
  );
  return <Text style={style}>{children}</Text>;
}

interface MarkdownInheritedCodeLinkProps {
  href: string;
  inheritedStyles: TextStyle;
  codeInlineStyle: TextStyle;
  linkStyle: TextStyle;
  onPress: (url: string) => boolean;
  children: ReactNode;
}

function MarkdownInheritedCodeLink({
  href,
  inheritedStyles,
  codeInlineStyle,
  linkStyle,
  onPress,
  children,
}: MarkdownInheritedCodeLinkProps) {
  const style = useMemo(
    () => [inheritedStyles, codeInlineStyle, linkStyle],
    [inheritedStyles, codeInlineStyle, linkStyle],
  );
  return (
    <MarkdownLink href={href} style={style} onPress={onPress}>
      {children}
    </MarkdownLink>
  );
}

interface MarkdownListItemContentProps {
  contentStyle: ViewStyle;
  children: ReactNode;
}

const MARKDOWN_LIST_ITEM_CONTENT_FLEX: ViewStyle = { flex: 1, flexShrink: 1, minWidth: 0 };

function MarkdownListItemContent({ contentStyle, children }: MarkdownListItemContentProps) {
  const style = useMemo(() => [contentStyle, MARKDOWN_LIST_ITEM_CONTENT_FLEX], [contentStyle]);
  return <View style={style}>{children}</View>;
}

interface MarkdownParagraphViewProps {
  paragraphStyle: ViewStyle;
  children: ReactNode;
}

const MARKDOWN_PARAGRAPH_RESET: ViewStyle = { marginBottom: 0 };

function MarkdownParagraphView({ paragraphStyle, children }: MarkdownParagraphViewProps) {
  const style = useMemo(() => [paragraphStyle, MARKDOWN_PARAGRAPH_RESET], [paragraphStyle]);
  return <View style={style}>{children}</View>;
}

export const AssistantMessage = memo(function AssistantMessage({
  message,
  timestamp: _timestamp,
  onInlinePathPress,
  workspaceRoot,
  serverId,
  client,
  disableOuterSpacing,
  spacing = "default",
}: AssistantMessageProps) {
  const resolvedDisableOuterSpacing = useDisableOuterSpacing(
    disableOuterSpacing ?? spacing !== "default",
  );

  const markdownParser = useMemo(() => {
    const parser = MarkdownIt({ typographer: true, linkify: true });
    const defaultValidateLink = parser.validateLink.bind(parser);
    parser.validateLink = (url: string) => {
      if (url.trim().toLowerCase().startsWith("file://")) {
        return true;
      }

      return defaultValidateLink(url);
    };
    return parser;
  }, []);

  const handleLinkPress = useCallback(
    (url: string) => {
      const fileTarget = onInlinePathPress ? parseAssistantFileLink(url, { workspaceRoot }) : null;
      if (fileTarget) {
        onInlinePathPress?.(fileTarget);
        return false;
      }

      void openExternalUrl(url);
      // react-native-markdown-display opens the link itself when this returns true.
      // We already handled it above, so return false to avoid duplicate opens.
      return false;
    },
    [onInlinePathPress, workspaceRoot],
  );

  const markdownRules = useMemo<RenderRules>(() => {
    return {
      text: (
        node: ASTNode,
        _children: ReactNode[],
        _parent: ASTNode[],
        styles: MarkdownStyles,
        inheritedStyles: TextStyle = {},
      ) => (
        <MarkdownInheritedText
          key={node.key}
          inheritedStyles={inheritedStyles}
          textStyle={styles.text}
        >
          {node.content}
        </MarkdownInheritedText>
      ),
      textgroup: (
        node: ASTNode,
        children: ReactNode[],
        _parent: ASTNode[],
        styles: MarkdownStyles,
        inheritedStyles: TextStyle = {},
      ) => (
        <MarkdownInheritedText
          key={node.key}
          inheritedStyles={inheritedStyles}
          textStyle={styles.textgroup}
        >
          {children}
        </MarkdownInheritedText>
      ),
      code_block: (
        node: ASTNode,
        _children: ReactNode[],
        _parent: ASTNode[],
        styles: MarkdownStyles,
        inheritedStyles: TextStyle = {},
      ) => (
        <MarkdownInheritedText
          key={node.key}
          inheritedStyles={inheritedStyles}
          textStyle={styles.code_block}
        >
          {node.content}
        </MarkdownInheritedText>
      ),
      fence: (
        node: ASTNode,
        _children: ReactNode[],
        _parent: ASTNode[],
        styles: MarkdownStyles,
        inheritedStyles: TextStyle = {},
      ) => (
        <MarkdownInheritedText
          key={node.key}
          inheritedStyles={inheritedStyles}
          textStyle={styles.fence}
        >
          {node.content}
        </MarkdownInheritedText>
      ),
      code_inline: (
        node: ASTNode,
        _children: ReactNode[],
        parent: ASTNode[],
        styles: MarkdownStyles,
        inheritedStyles: TextStyle = {},
      ) => {
        const content = node.content ?? "";
        const isLinkedInlineCode = nodeHasParentType(parent, "link");
        const parsed =
          onInlinePathPress && !isLinkedInlineCode ? parseInlinePathToken(content) : null;

        if (parsed && onInlinePathPress) {
          return (
            <InlinePathChip
              key={node.key}
              content={content}
              parsed={parsed}
              onPress={onInlinePathPress}
            />
          );
        }

        const inlineCodeLinkUrl = getInlineCodeAutoLinkUrl(markdownParser, content);
        if (inlineCodeLinkUrl) {
          return (
            <MarkdownInheritedCodeLink
              key={node.key}
              href={inlineCodeLinkUrl}
              inheritedStyles={inheritedStyles}
              codeInlineStyle={styles.code_inline}
              linkStyle={styles.link}
              onPress={handleLinkPress}
            >
              {content}
            </MarkdownInheritedCodeLink>
          );
        }

        return (
          <MarkdownInheritedText
            key={node.key}
            inheritedStyles={inheritedStyles}
            textStyle={styles.code_inline}
          >
            {content}
          </MarkdownInheritedText>
        );
      },
      bullet_list: (
        node: ASTNode,
        children: ReactNode[],
        _parent: ASTNode[],
        styles: MarkdownStyles,
      ) => (
        <View key={node.key} style={styles.bullet_list}>
          {children}
        </View>
      ),
      ordered_list: (
        node: ASTNode,
        children: ReactNode[],
        _parent: ASTNode[],
        styles: MarkdownStyles,
      ) => (
        <View key={node.key} style={styles.ordered_list}>
          {children}
        </View>
      ),
      list_item: (
        node: ASTNode,
        children: ReactNode[],
        parent: ASTNode[],
        styles: MarkdownStyles,
      ) => {
        const { isOrdered, marker } = getMarkdownListMarker(node, parent);
        const iconStyle = isOrdered ? styles.ordered_list_icon : styles.bullet_list_icon;
        const contentStyle = isOrdered ? styles.ordered_list_content : styles.bullet_list_content;

        return (
          <View key={node.key} style={styles.list_item}>
            <Text style={iconStyle}>{marker}</Text>
            <MarkdownListItemContent contentStyle={contentStyle}>
              {children}
            </MarkdownListItemContent>
          </View>
        );
      },
      paragraph: (
        node: ASTNode,
        children: ReactNode[],
        _parent: ASTNode[],
        styles: MarkdownStyles,
      ) => (
        <MarkdownParagraphView key={node.key} paragraphStyle={styles.paragraph}>
          {children}
        </MarkdownParagraphView>
      ),
      link: (node: ASTNode, children: ReactNode[], _parent: ASTNode[], styles: MarkdownStyles) => (
        <MarkdownLink
          key={node.key}
          href={typeof node.attributes?.href === "string" ? node.attributes.href : ""}
          style={styles.link}
          onPress={handleLinkPress}
        >
          {Children.map(children, (child) => {
            if (!isValidElement(child)) return child;
            const childProps = child.props as { style?: StyleProp<TextStyle> };
            return cloneElement(child, {
              style: [childProps.style, { color: styles.link.color }],
            } as Partial<{ style: StyleProp<TextStyle> }>);
          })}
        </MarkdownLink>
      ),
      image: (
        node: ASTNode,
        _children: ReactNode[],
        parent: ASTNode[],
        _styles: MarkdownStyles,
      ) => {
        const paragraphNode = Array.isArray(parent)
          ? parent.find((ancestor) => ancestor?.type === "paragraph")
          : null;
        const paragraphChildren = Array.isArray(paragraphNode?.children)
          ? paragraphNode.children
          : [];
        const imageIndex = paragraphChildren.findIndex((child: ASTNode) => child?.key === node.key);
        const hasLeadingContent = imageIndex > 0;

        return (
          <AssistantMarkdownImage
            key={node.key}
            source={String(node.attributes?.src ?? "")}
            alt={typeof node.attributes?.alt === "string" ? node.attributes.alt : undefined}
            hasLeadingContent={hasLeadingContent}
            client={client}
            workspaceRoot={workspaceRoot}
            serverId={serverId}
          />
        );
      },
    };
  }, [client, handleLinkPress, markdownParser, onInlinePathPress, serverId, workspaceRoot]);

  const blocks = useMemo(() => splitMarkdownBlocks(message), [message]);
  const keyedBlocks = useMemo(
    () => blocks.map((block, index) => ({ key: `${index}:${block.slice(0, 32)}`, block })),
    [blocks],
  );

  const assistantContainerStyle = useMemo(
    () => [
      assistantMessageStylesheet.container,
      (spacing === "compactTop" || spacing === "compactBoth") &&
        assistantMessageStylesheet.containerCompactTop,
      (spacing === "compactBottom" || spacing === "compactBoth") &&
        assistantMessageStylesheet.containerCompactBottom,
      !resolvedDisableOuterSpacing && assistantMessageStylesheet.containerSpacing,
    ],
    [spacing, resolvedDisableOuterSpacing],
  );

  return (
    <View testID="assistant-message" style={assistantContainerStyle}>
      {keyedBlocks.map(({ key, block }, index) => (
        <AssistantMessageBlockContainer
          key={key}
          block={block}
          marginBottom={index < keyedBlocks.length - 1 ? 12 : 0}
        >
          <MemoizedMarkdownBlock
            text={block}
            rules={markdownRules}
            parser={markdownParser}
            onLinkPress={handleLinkPress}
          />
        </AssistantMessageBlockContainer>
      ))}
    </View>
  );
});

interface SpeakMessageProps {
  message: string;
  timestamp: number;
  disableOuterSpacing?: boolean;
}

const speakMessageStylesheet = StyleSheet.create((theme) => ({
  container: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[3],
  },
  containerSpacing: {
    marginBottom: theme.spacing[4],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginBottom: theme.spacing[2],
  },
  headerLabel: {
    fontFamily: Fonts.sans,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  text: {
    fontFamily: Fonts.sans,
    fontSize: theme.fontSize.base,
    lineHeight: 22,
    color: theme.colors.foreground,
  },
}));

export const SpeakMessage = memo(function SpeakMessage({
  message,
  timestamp: _timestamp,
  disableOuterSpacing,
}: SpeakMessageProps) {
  const resolvedDisableOuterSpacing = useDisableOuterSpacing(disableOuterSpacing);
  const containerStyle = useMemo(
    () => [
      speakMessageStylesheet.container,
      !resolvedDisableOuterSpacing && speakMessageStylesheet.containerSpacing,
    ],
    [resolvedDisableOuterSpacing],
  );

  return (
    <View testID="speak-message" style={containerStyle}>
      <View style={speakMessageStylesheet.header}>
        <ThemedMicVocal size={12} uniProps={foregroundMutedColorMapping} />
        <Text style={speakMessageStylesheet.headerLabel}>Spoke</Text>
      </View>
      <Text style={speakMessageStylesheet.text}>{message}</Text>
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
  errorBg: {},
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
    height: 20,
    justifyContent: "center",
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
  timestamp: _timestamp,
  metadata,
  artifactId,
  artifactType,
  title,
  onArtifactClick,
  disableOuterSpacing,
}: ActivityLogProps) {
  const resolvedDisableOuterSpacing = useDisableOuterSpacing(disableOuterSpacing);
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

  const handlePress = useCallback(() => {
    if (type === "artifact" && artifactId && onArtifactClick) {
      onArtifactClick(artifactId);
    } else if (metadata) {
      setIsExpanded((prev) => !prev);
    }
  }, [type, artifactId, onArtifactClick, metadata]);

  const displayMessage =
    type === "artifact" && artifactType && title ? `${artifactType}: ${title}` : message;

  const isInteractive = type === "artifact" || metadata;
  const pressableStyle = useMemo(
    () => [
      activityLogStylesheet.pressable,
      !resolvedDisableOuterSpacing && activityLogStylesheet.pressableSpacing,
      config.bg,
      isInteractive && activityLogStylesheet.pressableActive,
    ],
    [resolvedDisableOuterSpacing, config.bg, isInteractive],
  );
  const messageTextStyle = useMemo(
    () => [activityLogStylesheet.messageText, { color: config.color }],
    [config.color],
  );

  return (
    <Pressable onPress={handlePress} disabled={!isInteractive} style={pressableStyle}>
      <View style={activityLogStylesheet.content}>
        <View style={activityLogStylesheet.row}>
          <View style={activityLogStylesheet.iconContainer}>
            <IconComponent size={16} color={config.color} />
          </View>
          <View style={activityLogStylesheet.textContainer}>
            <Text style={messageTextStyle} selectable>
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
  let label: string;
  if (status === "loading") label = "Compacting...";
  else if (preTokens) label = `Context compacted (${Math.round(preTokens / 1000)}K tokens)`;
  else label = "Context compacted";

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

interface TodoListItemRowProps {
  text: string;
  completed: boolean;
}

function TodoListItemRow({ text, completed }: TodoListItemRowProps) {
  const badgeStyle = useMemo(
    () => [
      todoListCardStylesheet.radioBadge,
      completed
        ? todoListCardStylesheet.radioBadgeComplete
        : todoListCardStylesheet.radioBadgeIncomplete,
    ],
    [completed],
  );
  const textStyle = useMemo(
    () => [todoListCardStylesheet.itemText, completed && todoListCardStylesheet.itemTextCompleted],
    [completed],
  );
  return (
    <View style={todoListCardStylesheet.itemRow}>
      <View style={badgeStyle}>
        {completed ? (
          <ThemedTodoCheckIcon size={12} uniProps={primaryForegroundColorMapping} />
        ) : null}
      </View>
      <Text style={textStyle}>{text}</Text>
    </View>
  );
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
            items.map((item) => (
              <TodoListItemRow key={item.text} text={item.text} completed={item.completed} />
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
  onOpenFile?: () => void;
  onDetailHoverChange?: (hovered: boolean) => void;
  renderDetails?: () => ReactNode;
  isLoading?: boolean;
  isError?: boolean;
  isLastInSequence?: boolean;
  disableOuterSpacing?: boolean;
  testID?: string;
}

interface ExpandableBadgeSecondaryLabelProps {
  secondaryLabel?: string;
  secondaryLabelStyle: StyleProp<TextStyle>;
  shouldMeasureWebShimmer: boolean;
  onSecondaryLayout: (event: LayoutChangeEvent) => void;
}

function ExpandableBadgeSecondaryLabel({
  secondaryLabel,
  secondaryLabelStyle,
  shouldMeasureWebShimmer,
  onSecondaryLayout,
}: ExpandableBadgeSecondaryLabelProps) {
  if (!secondaryLabel) {
    return null;
  }
  return (
    <Text
      style={secondaryLabelStyle}
      numberOfLines={1}
      onLayout={shouldMeasureWebShimmer ? onSecondaryLayout : undefined}
    >
      {secondaryLabel}
    </Text>
  );
}

interface ExpandableBadgeWebShimmerOverlayProps {
  label: string;
  secondaryLabel?: string;
  shimmerLabelTextStyle: StyleProp<TextStyle>;
  shimmerSecondaryTextStyle: StyleProp<TextStyle>;
  showOpenFileButton: boolean;
}

function ExpandableBadgeWebShimmerOverlay({
  label,
  secondaryLabel,
  shimmerLabelTextStyle,
  shimmerSecondaryTextStyle,
  showOpenFileButton,
}: ExpandableBadgeWebShimmerOverlayProps) {
  return (
    <View style={expandableBadgeStylesheet.shimmerOverlay} pointerEvents="none">
      <Text style={shimmerLabelTextStyle} numberOfLines={1}>
        {label}
      </Text>
      {secondaryLabel ? (
        <Text style={shimmerSecondaryTextStyle} numberOfLines={1}>
          {secondaryLabel}
        </Text>
      ) : null}
      {showOpenFileButton ? (
        <View style={expandableBadgeStylesheet.openFileButton}>
          <View style={expandableBadgeStylesheet.openFileButtonPlaceholderIcon} />
        </View>
      ) : null}
      {!secondaryLabel && !showOpenFileButton ? (
        <View style={expandableBadgeStylesheet.spacer} />
      ) : null}
    </View>
  );
}

interface ExpandableBadgeLabelRowProps {
  label: string;
  labelStyle: StyleProp<TextStyle>;
  secondaryLabel?: string;
  secondaryLabelStyle: StyleProp<TextStyle>;
  shouldMeasureWebShimmer: boolean;
  shouldMeasureNativeShimmer: boolean;
  isWebShimmer: boolean;
  isNativeShimmer: boolean;
  shimmerLabelTextStyle: StyleProp<TextStyle>;
  shimmerSecondaryTextStyle: StyleProp<TextStyle>;
  labelRowWidth: number;
  labelRowHeight: number;
  nativeShimmerPeakWidth: number;
  shimmerDuration: number;
  nativeGradientId: string;
  onLabelRowLayout: (event: LayoutChangeEvent) => void;
  onLabelLayout: (event: LayoutChangeEvent) => void;
  onSecondaryLayout: (event: LayoutChangeEvent) => void;
  showOpenFileButton: boolean;
  isOpenFileHovered: boolean;
  onOpenFilePress: (event: GestureResponderEvent) => void;
  onOpenFileHoverIn: () => void;
  onOpenFileHoverOut: () => void;
}

function ExpandableBadgeLabelRow({
  label,
  labelStyle,
  secondaryLabel,
  secondaryLabelStyle,
  shouldMeasureWebShimmer,
  shouldMeasureNativeShimmer,
  isWebShimmer,
  isNativeShimmer,
  shimmerLabelTextStyle,
  shimmerSecondaryTextStyle,
  labelRowWidth,
  labelRowHeight,
  nativeShimmerPeakWidth,
  shimmerDuration,
  nativeGradientId,
  onLabelRowLayout,
  onLabelLayout,
  onSecondaryLayout,
  showOpenFileButton,
  isOpenFileHovered,
  onOpenFilePress,
  onOpenFileHoverIn,
  onOpenFileHoverOut,
}: ExpandableBadgeLabelRowProps) {
  return (
    <View
      style={expandableBadgeStylesheet.labelRow}
      onLayout={shouldMeasureNativeShimmer ? onLabelRowLayout : undefined}
    >
      <Text
        style={labelStyle}
        numberOfLines={1}
        onLayout={shouldMeasureWebShimmer ? onLabelLayout : undefined}
      >
        {label}
      </Text>
      <ExpandableBadgeSecondaryLabel
        secondaryLabel={secondaryLabel}
        secondaryLabelStyle={secondaryLabelStyle}
        shouldMeasureWebShimmer={shouldMeasureWebShimmer}
        onSecondaryLayout={onSecondaryLayout}
      />
      {showOpenFileButton ? (
        <Pressable
          onPress={onOpenFilePress}
          onHoverIn={onOpenFileHoverIn}
          onHoverOut={onOpenFileHoverOut}
          accessibilityRole="button"
          accessibilityLabel="Open file"
          testID="tool-call-open-file"
          style={expandableBadgeStylesheet.openFileButton}
          hitSlop={6}
        >
          <ThemedFileSymlinkIcon
            size={14}
            uniProps={isOpenFileHovered ? foregroundColorMapping : foregroundMutedColorMapping}
          />
        </Pressable>
      ) : null}
      {isWebShimmer ? (
        <ExpandableBadgeWebShimmerOverlay
          label={label}
          secondaryLabel={secondaryLabel}
          shimmerLabelTextStyle={shimmerLabelTextStyle}
          shimmerSecondaryTextStyle={shimmerSecondaryTextStyle}
          showOpenFileButton={showOpenFileButton}
        />
      ) : null}
      {isNativeShimmer ? (
        <NativeExpandableBadgeShimmer
          label={label}
          secondaryLabel={secondaryLabel}
          rowWidth={labelRowWidth}
          rowHeight={labelRowHeight}
          peakWidth={nativeShimmerPeakWidth}
          durationSeconds={shimmerDuration}
          gradientId={nativeGradientId}
        />
      ) : null}
    </View>
  );
}

function renderExpandableBadgeIcon({
  isError,
  isActive,
  ThemedIcon,
}: {
  isError: boolean;
  isActive: boolean;
  ThemedIcon: ComponentType<{ size?: number; uniProps?: typeof foregroundColorMapping }> | null;
}): ReactNode {
  if (isError) {
    return <ThemedTriangleAlertIcon size={12} opacity={0.8} uniProps={destructiveColorMapping} />;
  }
  if (ThemedIcon) {
    return (
      <ThemedIcon
        size={12}
        uniProps={isActive ? foregroundColorMapping : mutedForegroundColorMapping}
      />
    );
  }
  return null;
}

function renderExpandableBadgeIconSlot({
  showChevron,
  chevronStyle,
  iconNode,
}: {
  showChevron: boolean;
  chevronStyle: StyleProp<ViewStyle>;
  iconNode: ReactNode;
}): ReactNode {
  if (showChevron) {
    return (
      <ThemedChevronRightIcon size={14} style={chevronStyle} uniProps={foregroundColorMapping} />
    );
  }
  return iconNode;
}

function computeShimmerMetrics(input: {
  label: string;
  secondaryLabel: string | undefined;
  isLoading: boolean;
  labelRowWidth: number;
  labelRowHeight: number;
  labelOffsetX: number;
  labelWidth: number;
  secondaryOffsetX: number;
  secondaryWidth: number;
}) {
  const totalShimmerChars = input.label.trim().length + (input.secondaryLabel?.trim().length ?? 0);
  const shortTextDurationAdjustment = totalShimmerChars <= 12 ? 0.25 : 0;
  const shimmerDuration = Math.max(
    1,
    Math.min(2.3, 1.25 + totalShimmerChars * 0.008 - shortTextDurationAdjustment),
  );
  const nativeShimmerPeakWidth = Math.max(
    32,
    Math.min(120, input.labelRowWidth > 0 ? input.labelRowWidth * 0.28 : 0),
  );
  const isWebShimmer = input.isLoading && isWeb;
  const shouldMeasureWebShimmer = isWebShimmer;
  const shouldMeasureNativeShimmer = input.isLoading && isNative;
  const isNativeShimmer =
    shouldMeasureNativeShimmer && input.labelRowWidth > 0 && input.labelRowHeight > 0;
  const webShimmerSpanStartX = input.labelOffsetX;
  const webShimmerSpanEndX = input.secondaryLabel
    ? input.secondaryOffsetX + input.secondaryWidth
    : input.labelOffsetX + input.labelWidth;
  const webShimmerSpanWidth = Math.max(1, webShimmerSpanEndX - webShimmerSpanStartX);
  const webShimmerPeakWidth = Math.max(42, Math.min(120, webShimmerSpanWidth * 0.22));
  const webShimmerTrackStart = webShimmerSpanStartX - webShimmerPeakWidth;
  const webShimmerTrackEnd = webShimmerSpanEndX;
  return {
    shimmerDuration,
    nativeShimmerPeakWidth,
    isWebShimmer,
    shouldMeasureWebShimmer,
    shouldMeasureNativeShimmer,
    isNativeShimmer,
    webShimmerPeakWidth,
    webShimmerTrackStart,
    webShimmerTrackEnd,
  };
}

function useDetailWheelPropagationBlocker(input: {
  detailWrapperRef: React.RefObject<View | null>;
  enabled: boolean;
}): void {
  const { detailWrapperRef, enabled } = input;
  useEffect(() => {
    if (!enabled) {
      return () => {};
    }
    const rawRef: unknown = detailWrapperRef.current;
    if (!(rawRef instanceof HTMLElement)) {
      return () => {};
    }
    const node = rawRef;
    const stopWheelPropagation = (event: WheelEvent) => {
      if (shouldStopDetailWheelPropagation(node, event)) {
        event.stopPropagation();
      }
    };
    node.addEventListener("wheel", stopWheelPropagation, { passive: true });
    return () => {
      node.removeEventListener("wheel", stopWheelPropagation);
    };
  }, [detailWrapperRef, enabled]);
}

const SHIMMER_GRADIENT =
  "linear-gradient(90deg, rgba(255, 255, 255, 0) 0%, rgba(255, 255, 255, 0.45) 24%, #ffffff 40%, #ffffff 60%, rgba(255, 255, 255, 0.45) 76%, rgba(255, 255, 255, 0) 100%)";

function buildShimmerTextStyle(input: {
  isWebShimmer: boolean;
  webShimmerPeakWidth: number;
  shimmerDuration: number;
  webShimmerTrackStart: number;
  webShimmerTrackEnd: number;
  offsetX: number;
}): object | null {
  if (!input.isWebShimmer) return null;
  return {
    opacity: 1,
    color: "transparent",
    backgroundImage: SHIMMER_GRADIENT,
    backgroundSize: `${input.webShimmerPeakWidth}px 100%`,
    backgroundRepeat: "no-repeat",
    backgroundClip: "text",
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
    animation: `${WEB_TOOLCALL_SHIMMER_ANIMATION_NAME} ${input.shimmerDuration}s linear infinite`,
    "--paseo-shimmer-start": `${input.webShimmerTrackStart - input.offsetX}px`,
    "--paseo-shimmer-end": `${input.webShimmerTrackEnd - input.offsetX}px`,
  };
}

const ExpandableBadge = memo(function ExpandableBadge({
  label,
  style,
  secondaryLabel,
  icon,
  isExpanded,
  onToggle,
  onOpenFile,
  onDetailHoverChange,
  renderDetails,
  isLoading = false,
  isError = false,
  isLastInSequence = false,
  disableOuterSpacing,
  testID,
}: ExpandableBadgeProps) {
  const resolvedDisableOuterSpacing = useDisableOuterSpacing(disableOuterSpacing);
  const [isHovered, setIsHovered] = useState(false);
  const [isOpenFileHovered, setIsOpenFileHovered] = useState(false);
  const [isIconHovered, setIsIconHovered] = useState(false);
  const [isPressed, setIsPressed] = useState(false);
  const isInteractive = Boolean(onToggle);
  const hasDetailContent = Boolean(renderDetails);
  const detailContent = hasDetailContent && isExpanded ? renderDetails?.() : null;
  const detailWrapperRef = useRef<View | null>(null);

  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => {
    setIsHovered(false);
    setIsPressed(false);
  }, []);
  const handlePressIn = useCallback(() => setIsPressed(true), []);
  const handlePressOut = useCallback(() => setIsPressed(false), []);
  const handleDetailHoverIn = useCallback(() => onDetailHoverChange?.(true), [onDetailHoverChange]);
  const handleDetailHoverOut = useCallback(
    () => onDetailHoverChange?.(false),
    [onDetailHoverChange],
  );
  const handleOpenFilePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation?.();
      onOpenFile?.();
    },
    [onOpenFile],
  );
  const handleOpenFileHoverIn = useCallback(() => setIsOpenFileHovered(true), []);
  const handleOpenFileHoverOut = useCallback(() => setIsOpenFileHovered(false), []);
  const handleIconHoverIn = useCallback(() => setIsIconHovered(true), []);
  const handleIconHoverOut = useCallback(() => setIsIconHovered(false), []);

  const nativeGradientIdRef = useRef(
    `shimmer-gradient-${Math.random().toString(36).substring(2, 9)}`,
  );
  const [labelRowWidth, setLabelRowWidth] = useState(0);
  const [labelRowHeight, setLabelRowHeight] = useState(0);
  const [labelOffsetX, setLabelOffsetX] = useState(0);
  const [labelWidth, setLabelWidth] = useState(0);
  const [secondaryOffsetX, setSecondaryOffsetX] = useState(0);
  const [secondaryWidth, setSecondaryWidth] = useState(0);

  const {
    shimmerDuration,
    nativeShimmerPeakWidth,
    isWebShimmer,
    shouldMeasureWebShimmer,
    shouldMeasureNativeShimmer,
    isNativeShimmer,
    webShimmerPeakWidth,
    webShimmerTrackStart,
    webShimmerTrackEnd,
  } = computeShimmerMetrics({
    label,
    secondaryLabel,
    isLoading,
    labelRowWidth,
    labelRowHeight,
    labelOffsetX,
    labelWidth,
    secondaryOffsetX,
    secondaryWidth,
  });

  const handleLabelRowLayout = useCallback(
    (event: LayoutChangeEvent) => {
      if (!shouldMeasureNativeShimmer) {
        return;
      }
      const { width, height } = event.nativeEvent.layout;
      setLabelRowWidth((previous) => (Math.abs(previous - width) > 0.5 ? width : previous));
      setLabelRowHeight((previous) => (Math.abs(previous - height) > 0.5 ? height : previous));
    },
    [shouldMeasureNativeShimmer],
  );

  const handleLabelLayout = useCallback(
    (event: LayoutChangeEvent) => {
      if (!shouldMeasureWebShimmer) {
        return;
      }
      const { x, width } = event.nativeEvent.layout;
      setLabelOffsetX((previous) => (Math.abs(previous - x) > 0.5 ? x : previous));
      setLabelWidth((previous) => (Math.abs(previous - width) > 0.5 ? width : previous));
    },
    [shouldMeasureWebShimmer],
  );

  const handleSecondaryLayout = useCallback(
    (event: LayoutChangeEvent) => {
      if (!shouldMeasureWebShimmer || !secondaryLabel) {
        return;
      }
      const { x, width } = event.nativeEvent.layout;
      setSecondaryOffsetX((previous) => (Math.abs(previous - x) > 0.5 ? x : previous));
      setSecondaryWidth((previous) => (Math.abs(previous - width) > 0.5 ? width : previous));
    },
    [shouldMeasureWebShimmer, secondaryLabel],
  );

  useEffect(() => {
    if (!isWebShimmer) {
      return;
    }
    ensureWebToolCallShimmerKeyframes();
  }, [isWebShimmer]);

  useDetailWheelPropagationBlocker({
    detailWrapperRef,
    enabled: !isNative && isExpanded && hasDetailContent,
  });

  const shimmerLabelStyle = useMemo<StyleProp<TextStyle>>(
    () =>
      buildShimmerTextStyle({
        isWebShimmer,
        webShimmerPeakWidth,
        shimmerDuration,
        webShimmerTrackStart,
        webShimmerTrackEnd,
        offsetX: labelOffsetX,
      }),
    [
      isWebShimmer,
      webShimmerPeakWidth,
      shimmerDuration,
      webShimmerTrackStart,
      webShimmerTrackEnd,
      labelOffsetX,
    ],
  );

  const shimmerSecondaryStyle = useMemo<StyleProp<TextStyle>>(
    () =>
      buildShimmerTextStyle({
        isWebShimmer,
        webShimmerPeakWidth,
        shimmerDuration,
        webShimmerTrackStart,
        webShimmerTrackEnd,
        offsetX: secondaryOffsetX,
      }),
    [
      isWebShimmer,
      webShimmerPeakWidth,
      shimmerDuration,
      webShimmerTrackStart,
      webShimmerTrackEnd,
      secondaryOffsetX,
    ],
  );

  const containerStyle = useMemo(
    () => [
      expandableBadgeStylesheet.container,
      !resolvedDisableOuterSpacing &&
        (isLastInSequence
          ? expandableBadgeStylesheet.containerLastInSequence
          : expandableBadgeStylesheet.containerSpacing),
      style,
    ],
    [isLastInSequence, resolvedDisableOuterSpacing, style],
  );

  const pressableStyle = useMemo(
    () => [
      expandableBadgeStylesheet.pressable,
      isPressed && isInteractive ? expandableBadgeStylesheet.pressablePressed : null,
      isExpanded && expandableBadgeStylesheet.pressableExpanded,
    ],
    [isExpanded, isInteractive, isPressed],
  );

  const accessibilityState = useMemo(
    () => (isInteractive ? { expanded: isExpanded } : undefined),
    [isExpanded, isInteractive],
  );

  const isActive = isHovered || isExpanded;

  const labelStyle = useMemo(
    () => [
      expandableBadgeStylesheet.label,
      isActive && expandableBadgeStylesheet.labelActive,
      isLoading && expandableBadgeStylesheet.labelLoading,
    ],
    [isActive, isLoading],
  );

  const secondaryLabelStyle = useMemo(
    () => [
      expandableBadgeStylesheet.secondaryLabel,
      isActive && expandableBadgeStylesheet.secondaryLabelActive,
    ],
    [isActive],
  );

  const shimmerLabelTextStyle = useMemo(
    () => [
      expandableBadgeStylesheet.label,
      isLoading && expandableBadgeStylesheet.labelLoading,
      expandableBadgeStylesheet.shimmerText,
      shimmerLabelStyle,
    ],
    [isLoading, shimmerLabelStyle],
  );

  const shimmerSecondaryTextStyle = useMemo(
    () => [
      expandableBadgeStylesheet.secondaryLabel,
      expandableBadgeStylesheet.shimmerText,
      shimmerSecondaryStyle,
    ],
    [shimmerSecondaryStyle],
  );

  const chevronStyle = useMemo(
    () => [
      expandableBadgeStylesheet.chevron,
      isExpanded && expandableBadgeStylesheet.chevronExpanded,
    ],
    [isExpanded],
  );

  const ThemedIcon = useMemo(() => (icon ? withUnistyles(icon) : null), [icon]);
  const iconNode = renderExpandableBadgeIcon({ isError, isActive, ThemedIcon });
  const iconSlotNode = renderExpandableBadgeIconSlot({
    showChevron: isInteractive && isHovered && !isIconHovered,
    chevronStyle,
    iconNode,
  });

  const pressHandlers = isInteractive
    ? {
        onPress: onToggle,
        onPressIn: handlePressIn,
        onPressOut: handlePressOut,
        accessibilityRole: "button" as const,
      }
    : {};

  return (
    <View
      style={containerStyle}
      testID={testID}
      onPointerEnter={isWeb ? handleHoverIn : undefined}
      onPointerLeave={isWeb ? handleHoverOut : undefined}
    >
      <Pressable
        {...pressHandlers}
        disabled={!isInteractive}
        accessibilityState={accessibilityState}
        style={pressableStyle}
      >
        <View style={expandableBadgeStylesheet.headerRow}>
          <View
            style={expandableBadgeStylesheet.iconBadge}
            onPointerEnter={isWeb ? handleIconHoverIn : undefined}
            onPointerLeave={isWeb ? handleIconHoverOut : undefined}
          >
            {iconSlotNode}
          </View>
          <ExpandableBadgeLabelRow
            label={label}
            labelStyle={labelStyle}
            secondaryLabel={secondaryLabel}
            secondaryLabelStyle={secondaryLabelStyle}
            shouldMeasureWebShimmer={shouldMeasureWebShimmer}
            shouldMeasureNativeShimmer={shouldMeasureNativeShimmer}
            isWebShimmer={isWebShimmer}
            isNativeShimmer={isNativeShimmer}
            shimmerLabelTextStyle={shimmerLabelTextStyle}
            shimmerSecondaryTextStyle={shimmerSecondaryTextStyle}
            labelRowWidth={labelRowWidth}
            labelRowHeight={labelRowHeight}
            nativeShimmerPeakWidth={nativeShimmerPeakWidth}
            shimmerDuration={shimmerDuration}
            nativeGradientId={nativeGradientIdRef.current}
            onLabelRowLayout={handleLabelRowLayout}
            onLabelLayout={handleLabelLayout}
            onSecondaryLayout={handleSecondaryLayout}
            showOpenFileButton={Boolean(onOpenFile && isHovered)}
            isOpenFileHovered={isOpenFileHovered}
            onOpenFilePress={handleOpenFilePress}
            onOpenFileHoverIn={handleOpenFileHoverIn}
            onOpenFileHoverOut={handleOpenFileHoverOut}
          />
        </View>
      </Pressable>
      {detailContent ? (
        <Pressable
          ref={detailWrapperRef}
          style={expandableBadgeStylesheet.detailWrapper}
          onHoverIn={handleDetailHoverIn}
          onHoverOut={handleDetailHoverOut}
        >
          {detailContent}
        </Pressable>
      ) : null}
    </View>
  );
}, areExpandableBadgePropsEqual);

function areExpandableBadgePropsEqual(previous: ExpandableBadgeProps, next: ExpandableBadgeProps) {
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
  if (previous.onToggle !== next.onToggle) return false;
  if (previous.onOpenFile !== next.onOpenFile) return false;
  if (previous.onDetailHoverChange !== next.onDetailHoverChange) return false;
  if (previous.renderDetails !== next.renderDetails) return false;
  return true;
}

interface ToolCallProps {
  toolName: string;
  args?: unknown;
  result?: unknown;
  error?: unknown;
  status: "executing" | "running" | "completed" | "failed" | "canceled";
  detail?: ToolCallDetail;
  cwd?: string;
  metadata?: Record<string, unknown>;
  isLastInSequence?: boolean;
  disableOuterSpacing?: boolean;
  onInlineDetailsHoverChange?: (hovered: boolean) => void;
  onInlineDetailsExpandedChange?: (expanded: boolean) => void;
  onOpenFilePath?: (filePath: string) => void;
}

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
  onOpenFilePath,
}: ToolCallProps) {
  const { openToolCall } = useToolCallSheet();
  const [isExpanded, setIsExpanded] = useState(false);

  // Check if we're on mobile (use bottom sheet) or desktop (inline expand)
  const isMobile = useIsCompactFormFactor();

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

  const displayDetail = useMemo<ToolCallDetail>(
    () =>
      effectiveDetail ?? {
        type: "unknown",
        input: null,
        output: null,
      },
    [effectiveDetail],
  );

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
    [toolName, status, error, displayDetail, metadata, cwd],
  );
  const displayName = displayModel.displayName;
  const summary = displayModel.summary;
  const errorText = displayModel.errorText;
  const IconComponent = resolveToolCallIcon(toolName, effectiveDetail);
  const isLoadingDetails = isPendingToolCallDetail({
    detail: effectiveDetail,
    status,
    error,
  });
  const secondaryLabel = summary;

  // Check if there's any content to display
  const hasDetails = Boolean(error) || hasMeaningfulToolCallDetail(effectiveDetail);
  const canOpenDetails = hasDetails || isLoadingDetails;

  const extractedFilePath = useMemo(
    () => extractToolCallFilePath(effectiveDetail),
    [effectiveDetail],
  );
  const handleOpenFile = useMemo(() => {
    if (!extractedFilePath || !onOpenFilePath) {
      return undefined;
    }
    return () => onOpenFilePath(extractedFilePath);
  }, [extractedFilePath, onOpenFilePath]);

  const handleToggle = useCallback(() => {
    if (isMobile) {
      openToolCall({
        toolName,
        displayName,
        summary: secondaryLabel,
        detail: effectiveDetail,
        errorText,
        showLoadingSkeleton: isLoadingDetails,
      });
    } else {
      setIsExpanded((prev) => !prev);
    }
  }, [
    isMobile,
    openToolCall,
    toolName,
    displayName,
    secondaryLabel,
    effectiveDetail,
    errorText,
    isLoadingDetails,
  ]);

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
      return () => {};
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
        showLoadingSkeleton={isLoadingDetails}
      />
    );
  }, [isMobile, effectiveDetail, errorText, isLoadingDetails]);

  if (effectiveDetail?.type === "plan") {
    return (
      <PlanCard
        title="Plan"
        text={effectiveDetail.text}
        testID="timeline-plan-card"
        disableOuterSpacing={disableOuterSpacing}
      />
    );
  }

  return (
    <ExpandableBadge
      testID="tool-call-badge"
      label={displayName}
      secondaryLabel={secondaryLabel}
      icon={IconComponent}
      isExpanded={!isMobile && isExpanded}
      onToggle={canOpenDetails ? handleToggle : undefined}
      onOpenFile={handleOpenFile}
      renderDetails={canOpenDetails && !isMobile ? renderDetails : undefined}
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
  if (previous.onOpenFilePath !== next.onOpenFilePath) return false;
  return true;
}
