import { useCallback, useMemo, useRef, useState } from "react";
import { withUnistyles } from "react-native-unistyles";
import type { BlockquoteRendererProps } from "react-native-enriched-markdown";
import { useTranslation } from "react-i18next";
import { createElementClipboardContent } from "@/assistant-selection-copy/content.web";
import { smallIconButtonChromeFrameSize } from "@/components/ui/icon-button-chrome";
import { paneContentToolbarIconSize } from "@/components/ui/pane-content-toolbar";
import { useIsCompactFormFactor } from "@/constants/layout";
import { writeClipboardContent } from "@/utils/rich-clipboard";
import { getDefaultMarkdownClipboardEnvironment } from "@/utils/rich-clipboard-default-environment";
import { BlockCopyButton, blockCopyGlyphInset } from "./block-copy-button";

interface WebBlockquoteProps extends BlockquoteRendererProps {
  copyGlyphInset: number;
}

/**
 * Room the quote reserves so the control never covers its text. Compact layouts always
 * show the control, so it gets a band above the body and the text keeps the full width.
 * Wide layouts reveal it on hover, where a band would leave an empty strip above every
 * quote, so the text wraps short of it instead.
 */
function copyRoom(compact: boolean, glyphInset: number) {
  if (compact) {
    return { paddingTop: glyphInset + paneContentToolbarIconSize(compact) + glyphInset };
  }
  return { paddingRight: smallIconButtonChromeFrameSize(compact) + glyphInset };
}

/** A quote with a control that copies its body, for drafts an agent wrote to be pasted elsewhere. */
export const WebBlockquote = withUnistyles(
  function WebBlockquote({ blockquoteProps, children, copyGlyphInset }: WebBlockquoteProps) {
    const { t } = useTranslation();
    const quote = useRef<HTMLQuoteElement>(null);
    const [hovered, setHovered] = useState(false);
    const compact = useIsCompactFormFactor();
    const enter = useCallback(() => setHovered(true), []);
    const leave = useCallback(() => setHovered(false), []);
    const style = useMemo(
      () => ({
        ...blockquoteProps.style,
        position: "relative" as const,
        ...copyRoom(compact, copyGlyphInset),
      }),
      [blockquoteProps.style, compact, copyGlyphInset],
    );
    const copy = useCallback(async () => {
      // Read the rendered body at press time: a streaming quote copies what it shows now.
      const content = quote.current && createElementClipboardContent(quote.current);
      if (!content) return false;
      return writeClipboardContent(content, getDefaultMarkdownClipboardEnvironment());
    }, []);
    return (
      <blockquote
        {...blockquoteProps}
        ref={quote}
        style={style}
        onPointerEnter={enter}
        onPointerLeave={leave}
      >
        <BlockCopyButton
          onCopy={copy}
          visible={hovered || compact}
          label={t("message.actions.copyQuote")}
        />
        {children}
      </blockquote>
    );
  },
  (theme) => ({ copyGlyphInset: blockCopyGlyphInset(theme) }),
);
