import {
  useCallback,
  useMemo,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  Pressable,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { isNative, isWeb } from "@/constants/platform";
import type { OpenFileDisposition } from "@/workspace/file-open";
import { Shortcut } from "@/components/ui/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { DaemonClient } from "@server/client/daemon-client";
import type { InlinePathTarget } from "./parse";
import type { AssistantFileLinkSource } from "./resolver";
import { useAssistantFileLinkTarget } from "./use-resolver";

interface AssistantMarkdownLinkProps {
  source: AssistantFileLinkSource;
  style: StyleProp<TextStyle>;
  onPress: (source: AssistantFileLinkSource, disposition: OpenFileDisposition) => void;
  client?: DaemonClient | null;
  serverId?: string;
  workspaceRoot?: string;
  children: ReactNode;
}

export function AssistantMarkdownLink({
  source,
  style,
  onPress,
  client,
  serverId,
  workspaceRoot,
  children,
}: AssistantMarkdownLinkProps) {
  const [hovered, setHovered] = useState(false);
  const target = useAssistantFileLinkTarget({ source, client, serverId, workspaceRoot });
  const tooltipPath = useMemo(
    () => (target ? formatInlinePathTargetForTooltip(target, workspaceRoot) : null),
    [target, workspaceRoot],
  );
  const handlePress = useCallback(() => onPress(source, "main"), [onPress, source]);
  const handleAnchorClickCapture = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      if (!isModifiedOpenEvent(event)) {
        return;
      }
      event.stopPropagation();
      onPress(source, "side");
    },
    [onPress, source],
  );
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

  const anchor = (
    <a
      href={source.href}
      onClickCapture={handleAnchorClickCapture}
      onAuxClickCapture={preventAnchorNavigation}
      style={LINK_ANCHOR_STYLE}
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

  if (tooltipPath) {
    return <FileLinkHoverTooltip filePath={tooltipPath}>{anchor}</FileLinkHoverTooltip>;
  }
  return anchor;
}

interface AssistantMarkdownCodeLinkProps {
  source: AssistantFileLinkSource;
  inheritedStyles: TextStyle;
  codeInlineStyle: TextStyle;
  linkStyle: TextStyle;
  onPress: (source: AssistantFileLinkSource, disposition: OpenFileDisposition) => void;
  client?: DaemonClient | null;
  serverId?: string;
  workspaceRoot?: string;
  children: ReactNode;
}

export function AssistantMarkdownCodeLink({
  source,
  inheritedStyles,
  codeInlineStyle,
  linkStyle,
  onPress,
  client,
  serverId,
  workspaceRoot,
  children,
}: AssistantMarkdownCodeLinkProps) {
  const style = useMemo(
    () => [inheritedStyles, codeInlineStyle, linkStyle],
    [inheritedStyles, codeInlineStyle, linkStyle],
  );
  return (
    <AssistantMarkdownLink
      source={source}
      style={style}
      onPress={onPress}
      client={client}
      serverId={serverId}
      workspaceRoot={workspaceRoot}
    >
      {children}
    </AssistantMarkdownLink>
  );
}

interface AssistantInlineCodePathLinkProps {
  content: string;
  inheritedStyles: TextStyle;
  codeInlineStyle: TextStyle;
  linkStyle: TextStyle;
  onPress: (source: AssistantFileLinkSource, disposition: OpenFileDisposition) => void;
  client?: DaemonClient | null;
  serverId?: string;
  workspaceRoot?: string;
}

export function AssistantInlineCodePathLink({
  content,
  inheritedStyles,
  codeInlineStyle,
  linkStyle,
  onPress,
  client,
  serverId,
  workspaceRoot,
}: AssistantInlineCodePathLinkProps) {
  const source = useMemo<AssistantFileLinkSource>(
    () => ({
      href: content,
      text: content,
      sourceType: "inline-code",
    }),
    [content],
  );

  return (
    <AssistantMarkdownCodeLink
      source={source}
      inheritedStyles={inheritedStyles}
      codeInlineStyle={codeInlineStyle}
      linkStyle={linkStyle}
      onPress={onPress}
      client={client}
      serverId={serverId}
      workspaceRoot={workspaceRoot}
    >
      {content}
    </AssistantMarkdownCodeLink>
  );
}

function formatInlinePathTargetForTooltip(
  target: InlinePathTarget,
  workspaceRoot: string | undefined,
): string {
  let result = relativizePathToWorkspace(target.path, workspaceRoot);
  if (target.lineStart) {
    result += `:${target.lineStart}`;
    if (target.lineEnd && target.lineEnd !== target.lineStart) {
      result += `-${target.lineEnd}`;
    }
  }
  return result;
}

function relativizePathToWorkspace(filePath: string, workspaceRoot: string | undefined): string {
  if (!workspaceRoot) {
    return filePath;
  }
  const root = workspaceRoot.replace(/\/+$/, "");
  if (!root) {
    return filePath;
  }
  if (filePath === root) {
    return ".";
  }
  const prefix = `${root}/`;
  if (filePath.startsWith(prefix)) {
    return filePath.slice(prefix.length);
  }
  return filePath;
}

const FILE_LINK_TOOLTIP_TRIGGER_STYLE: ViewStyle = {
  // RN doesn't type "inline-flex" but RN-web honors it at runtime, which keeps
  // the tooltip wrapper from breaking inline link flow.
  display: "inline-flex" as ViewStyle["display"],
};

const FILE_LINK_TOOLTIP_MOD_KEYS = ["mod"];

function FileLinkHoverTooltip({ filePath, children }: { filePath: string; children: ReactNode }) {
  if (!isWeb) {
    return children;
  }
  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild>
        <View style={FILE_LINK_TOOLTIP_TRIGGER_STYLE}>{children}</View>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" maxWidth={520}>
        <View style={styles.tooltipBody}>
          <Text selectable={false} style={styles.tooltipPath}>
            {filePath}
          </Text>
          <View style={styles.tooltipHintRow}>
            <Shortcut keys={FILE_LINK_TOOLTIP_MOD_KEYS} />
            <Text selectable={false} style={styles.tooltipHintText}>
              click for side pane
            </Text>
          </View>
        </View>
      </TooltipContent>
    </Tooltip>
  );
}

const LINK_ANCHOR_STYLE: CSSProperties = {
  display: "contents",
  color: "inherit",
  textDecoration: "none",
};

function preventAnchorNavigation(event: MouseEvent<HTMLAnchorElement>): void {
  event.preventDefault();
}

function isModifiedOpenEvent(event: MouseEvent<HTMLElement>): boolean {
  return event.metaKey || event.ctrlKey;
}

const styles = StyleSheet.create((theme) => ({
  tooltipBody: {
    gap: theme.spacing[1],
  },
  tooltipPath: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
  },
  tooltipHintRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  tooltipHintText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
  },
}));
