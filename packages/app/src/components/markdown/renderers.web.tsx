import { Text } from "react-native";
import { forwardRef, useMemo, type ComponentProps } from "react";
import type {
  CodeBlockRendererProps,
  LinkRendererProps,
  MarkdownRenderers,
} from "react-native-enriched-markdown";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  useAssistantFileLinkEnvironment,
  useFileLink,
} from "@/assistant-file-links";
import { AssistantFileLinkContextMenuContent } from "@/assistant-file-links/file-context-menu";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { isWeb } from "@/constants/platform";
import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import type { Theme } from "@/styles/theme";
import type { ViewStyle } from "react-native";
import { MermaidFence } from "./fence/mermaid";
import { markdownLinkSource } from "./source";

const ThemedCodeBlock = withUnistyles(HighlightedCodeBlock);
const codeStyle = (theme: Theme) => ({
  inheritedStyles: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
  },
  textStyle: { backgroundColor: theme.colors.surface2, padding: 12, borderRadius: 8 },
});
function WebCodeBlock({ code, language }: CodeBlockRendererProps) {
  if (language?.toLowerCase() === "mermaid") return <MermaidFence code={code} />;
  return <ThemedCodeBlock code={code} language={language} uniProps={codeStyle} />;
}

const LINK_CONTEXT_TRIGGER_STYLE: ViewStyle = {
  display: "inline-flex" as ViewStyle["display"],
};

function WebLink({ link, anchorProps, children }: LinkRendererProps) {
  const source = markdownLinkSource(link.url, link.sourceType);
  const { target, open, tooltipPath, onHoverIn } = useFileLink(source);
  const { workspaceRoot, serverId } = useAssistantFileLinkEnvironment();
  const anchorStyle = useMemo(
    () => ({ ...anchorProps.style, overflowWrap: "anywhere" as const }),
    [anchorProps.style],
  );
  const anchor = (
    <a {...anchorProps} style={anchorStyle}>
      {children}
    </a>
  );
  const anchorWithContextMenu =
    target && isWeb ? (
      <ContextMenu>
        <ContextMenuTrigger contextOnly style={LINK_CONTEXT_TRIGGER_STYLE}>
          {anchor}
        </ContextMenuTrigger>
        <AssistantFileLinkContextMenuContent
          source={source}
          target={target}
          serverId={serverId ?? ""}
          workspaceRoot={workspaceRoot}
          onOpen={open}
          testIDPrefix="assistant-file-link"
        />
      </ContextMenu>
    ) : (
      anchor
    );
  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild onHoverIn={onHoverIn}>
        <InlineLinkTrigger>{anchorWithContextMenu}</InlineLinkTrigger>
      </TooltipTrigger>
      {tooltipPath ? (
        <TooltipContent side="top" align="start" maxWidth={520}>
          <Text selectable={false} style={styles.tooltipPath}>
            {tooltipPath}
          </Text>
        </TooltipContent>
      ) : null}
    </Tooltip>
  );
}
// TooltipTrigger also supplies native Pressable handlers; forward only DOM events.
// A View renders a div, which is invalid inside the library's prose paragraphs.
const InlineLinkTrigger = forwardRef<HTMLSpanElement, ComponentProps<"span">>(
  function InlineLinkTrigger({ children, onMouseEnter, onMouseLeave, onFocus, onBlur }, ref) {
    return (
      <span
        ref={ref}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onFocus={onFocus}
        onBlur={onBlur}
      >
        {children}
      </span>
    );
  },
);
const styles = StyleSheet.create((theme) => ({
  tooltipPath: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
}));

export const WEB_RENDERERS: MarkdownRenderers = { codeBlock: WebCodeBlock, link: WebLink };
