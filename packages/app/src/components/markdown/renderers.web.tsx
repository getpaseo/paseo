import { Text } from "react-native";
import { forwardRef, useCallback, useMemo, useRef, useState, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import type {
  BlockquoteRendererProps,
  CodeBlockRendererProps,
  LinkRendererProps,
  MarkdownRenderers,
} from "react-native-enriched-markdown";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useFileLink } from "@/assistant-file-links";
import { useForgeShorthand } from "@/git/forge-shorthand";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { CopyButton, HighlightedCodeBlock } from "@/components/highlighted-code-block";
import type { Theme } from "@/styles/theme";
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

// The quote keeps its text clear of the corner copy button.
const QUOTE_COPY_GUTTER = 44;

function WebBlockquote({ style, children }: BlockquoteRendererProps) {
  const { t } = useTranslation();
  const quoteRef = useRef<HTMLQuoteElement>(null);
  // The quote as it reads on screen, paragraph breaks kept: what the person would paste.
  const getText = useCallback(() => quoteRef.current?.innerText.trim() ?? "", []);
  const quoteStyle = useMemo(
    () => ({
      ...style,
      position: "relative" as const,
      paddingRight: QUOTE_COPY_GUTTER,
    }),
    [style],
  );
  return (
    <blockquote ref={quoteRef} style={quoteStyle}>
      {children}
      <CopyButton
        getCode={getText}
        visible
        label={t("message.actions.copyQuote")}
        chromeStyle={styles.quoteCopy}
        iconSize={15}
        copiedColor={styles.quoteCopied.color}
      />
    </blockquote>
  );
}

// The library styles links inline, so a stylesheet :hover rule cannot underline them.
const LINK_HOVER_STYLE = { textDecoration: "underline" } as const;

function WebLink({ link, anchorProps, children }: LinkRendererProps) {
  const forgeShorthand = useForgeShorthand();
  // A forge reference like `#12` carries its web URL so hover, copy and new-tab opens work.
  const forgeUrl = link.sourceType === "text" ? forgeShorthand?.resolve(link.url) : null;
  const { tooltipPath, onHoverIn } = useFileLink(
    forgeUrl ? markdownLinkSource(forgeUrl) : markdownLinkSource(link.url, link.sourceType),
  );
  const tooltip = forgeUrl ?? tooltipPath;
  const [hovered, setHovered] = useState(false);
  const handleMouseEnter = useCallback(() => setHovered(true), []);
  const handleMouseLeave = useCallback(() => setHovered(false), []);
  const anchorStyle = useMemo(
    () => ({
      ...anchorProps.style,
      overflowWrap: "anywhere" as const,
      ...(hovered ? LINK_HOVER_STYLE : null),
    }),
    [anchorProps.style, hovered],
  );
  const anchor = (
    <a
      {...anchorProps}
      href={forgeUrl ?? anchorProps.href}
      style={anchorStyle}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}
    </a>
  );
  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild onHoverIn={onHoverIn}>
        <InlineLinkTrigger>{anchor}</InlineLinkTrigger>
      </TooltipTrigger>
      {tooltip ? (
        <TooltipContent side="top" align="start" maxWidth={520}>
          <Text selectable={false} style={styles.tooltipPath}>
            {tooltip}
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
  quoteCopy: {
    padding: 6,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  quoteCopied: {
    color: theme.colors.statusSuccess,
  },
  tooltipPath: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
}));

export const WEB_RENDERERS: MarkdownRenderers = { codeBlock: WebCodeBlock, link: WebLink };

/** Assistant replies hand over drafts as quotes, so their quotes carry the copy button too. */
export const WEB_QUOTE_COPY_RENDERERS: MarkdownRenderers = {
  ...WEB_RENDERERS,
  blockquote: WebBlockquote,
};
