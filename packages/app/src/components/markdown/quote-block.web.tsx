import { useCallback, useMemo, useRef, useState } from "react";
import { withUnistyles } from "react-native-unistyles";
import type { BlockquoteRendererProps } from "react-native-enriched-markdown";
import { useTranslation } from "react-i18next";
import { smallIconButtonChromeFrameSize } from "@/components/ui/icon-button-chrome";
import { useIsCompactFormFactor } from "@/constants/layout";
import { markdownFromElementContents } from "@/assistant-selection-copy/content.web";
import { writeMarkdownToRichClipboard } from "@/utils/rich-clipboard";
import { getDefaultMarkdownClipboardEnvironment } from "@/utils/rich-clipboard-default-environment";
import { BlockCopyButton } from "./block-copy-button";

interface WebBlockquoteProps extends BlockquoteRendererProps {
  copyInset?: number;
}

export const WebBlockquote = withUnistyles(
  function WebBlockquote({ blockquoteProps, children, copyInset = 0 }: WebBlockquoteProps) {
    const { t } = useTranslation();
    const body = useRef<HTMLQuoteElement>(null);
    const [hovered, setHovered] = useState(false);
    const compact = useIsCompactFormFactor();
    const copyClearance = smallIconButtonChromeFrameSize(compact) + copyInset;
    const enter = useCallback(() => setHovered(true), []);
    const leave = useCallback(() => setHovered(false), []);
    const style = useMemo(
      () => ({
        ...blockquoteProps.style,
        position: "relative" as const,
        paddingRight: copyClearance,
      }),
      [blockquoteProps.style, copyClearance],
    );
    const copy = useCallback(async () => {
      if (!body.current) return false;
      const markdown = markdownFromElementContents(body.current);
      if (!markdown) return false;
      const written = await writeMarkdownToRichClipboard(
        markdown,
        getDefaultMarkdownClipboardEnvironment(),
      );
      if (!written) throw new Error("Clipboard write failed");
      return true;
    }, []);
    return (
      <blockquote
        {...blockquoteProps}
        ref={body}
        style={style}
        onMouseEnter={enter}
        onMouseLeave={leave}
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
  (theme) => ({
    copyInset: theme.spacing[2] + theme.spacing[1],
  }),
);
