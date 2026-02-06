'use dom';

import { useCallback, useEffect, useMemo, useRef } from "react";
import { renderAssistantMarkdownHtml } from "@/utils/assistant-markdown-html";
import { parseInlinePathToken, type InlinePathTarget } from "@/utils/inline-path";
import type { DOMProps } from "expo/dom";

type MarkdownDomTheme = {
  colors: {
    foreground: string;
    foregroundMuted: string;
    primary: string;
    border: string;
    surface1: string;
    surface2: string;
  };
  spacing: {
    1: number;
    2: number;
    3: number;
    4: number;
    6: number;
  };
  fontSize: {
    xs: number;
    sm: number;
    base: number;
    lg: number;
    xl: number;
    "2xl": number;
    "3xl": number;
  };
  fontWeight: {
    normal: string;
    medium: string;
    semibold: string;
    bold: string;
  };
  borderRadius: {
    sm: number;
    base: number;
    md: number;
    full: number;
  };
  borderWidth: {
    1: number;
  };
  fonts: {
    sans: string;
    mono: string;
  };
};

export type AssistantMarkdownDomProps = {
  markdown: string;
  theme: MarkdownDomTheme;
  style?: any;
  dom?: DOMProps;
  onHeightChangeAsync?: (height: number) => Promise<void>;
  onInlinePathPressAsync?: (target: InlinePathTarget) => Promise<void>;
  onLinkPressAsync?: (url: string) => Promise<void>;
};

export default function AssistantMarkdownDom({
  markdown,
  theme,
  onHeightChangeAsync,
  onInlinePathPressAsync,
  onLinkPressAsync,
}: AssistantMarkdownDomProps) {
  const lastReportedHeightRef = useRef<number>(0);

  const cssText = useMemo(() => {
    const { colors, spacing, fontSize, fontWeight, borderRadius, borderWidth, fonts } =
      theme;

    return `
html, body {
  margin: 0;
  padding: 0;
  background: transparent;
}

.paseo-markdown {
  color: ${colors.foreground};
  font-family: ${fonts.sans};
  font-size: ${fontSize.base}px;
  line-height: 22px;
  user-select: text;
  -webkit-user-select: text;
  overflow-wrap: anywhere;
}

.paseo-markdown p {
  margin: 0 0 ${spacing[3]}px 0;
}

.paseo-markdown h1 {
  font-size: ${fontSize["3xl"]}px;
  font-weight: ${fontWeight.bold};
  margin: ${spacing[6]}px 0 ${spacing[3]}px 0;
  line-height: 32px;
  border-bottom: ${borderWidth[1]}px solid ${colors.border};
  padding-bottom: ${spacing[2]}px;
}

.paseo-markdown h2 {
  font-size: ${fontSize["2xl"]}px;
  font-weight: ${fontWeight.bold};
  margin: ${spacing[6]}px 0 ${spacing[3]}px 0;
  line-height: 28px;
  border-bottom: ${borderWidth[1]}px solid ${colors.border};
  padding-bottom: ${spacing[2]}px;
}

.paseo-markdown h3 {
  font-size: ${fontSize.xl}px;
  font-weight: ${fontWeight.semibold};
  margin: ${spacing[4]}px 0 ${spacing[2]}px 0;
  line-height: 26px;
}

.paseo-markdown h4 {
  font-size: ${fontSize.lg}px;
  font-weight: ${fontWeight.semibold};
  margin: ${spacing[4]}px 0 ${spacing[2]}px 0;
  line-height: 24px;
}

.paseo-markdown h5 {
  font-size: ${fontSize.base}px;
  font-weight: ${fontWeight.semibold};
  margin: ${spacing[3]}px 0 ${spacing[1]}px 0;
  line-height: 22px;
}

.paseo-markdown h6 {
  font-size: ${fontSize.base}px;
  font-weight: ${fontWeight.semibold};
  margin: ${spacing[3]}px 0 ${spacing[1]}px 0;
  line-height: 20px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: ${colors.foregroundMuted};
}

.paseo-markdown a {
  color: ${colors.primary};
  text-decoration: underline;
}

.paseo-inline-code {
  background: ${colors.surface2};
  color: ${colors.foreground};
  padding: 2px ${spacing[2]}px;
  border-radius: ${borderRadius.sm}px;
  font-family: ${fonts.mono};
  font-size: 13px;
}

.paseo-path-chip {
  display: inline-block;
  background: ${colors.surface2};
  border-radius: ${borderRadius.full}px;
  padding: 2px ${spacing[2]}px;
  margin: 2px ${spacing[1]}px 2px 0;
  font-family: ${fonts.mono};
  font-size: 13px;
  cursor: pointer;
  user-select: text;
  -webkit-user-select: text;
}

.paseo-code-block {
  background: ${colors.surface2};
  color: ${colors.foreground};
  padding: ${spacing[3]}px;
  border-radius: ${borderRadius.md}px;
  border: ${borderWidth[1]}px solid ${colors.border};
  margin: ${spacing[3]}px 0;
  overflow-x: auto;
}

.paseo-code-block code {
  font-family: ${fonts.mono};
  font-size: ${fontSize.sm}px;
  white-space: pre;
}

.paseo-table-wrapper {
  overflow-x: auto;
  margin: ${spacing[3]}px 0;
}

.paseo-table {
  border: ${borderWidth[1]}px solid ${colors.border};
  border-radius: ${borderRadius.md}px;
  border-collapse: separate;
  border-spacing: 0;
  width: 100%;
  min-width: max-content;
  overflow: hidden;
}

.paseo-table th {
  background: ${colors.surface2};
  padding: ${spacing[2]}px;
  border-bottom: ${borderWidth[1]}px solid ${colors.border};
  border-right: ${borderWidth[1]}px solid ${colors.border};
  font-weight: ${fontWeight.semibold};
  font-size: ${fontSize.sm}px;
  text-align: left;
  white-space: nowrap;
}

.paseo-table td {
  padding: ${spacing[2]}px;
  border-bottom: ${borderWidth[1]}px solid ${colors.border};
  border-right: ${borderWidth[1]}px solid ${colors.border};
  font-size: ${fontSize.sm}px;
  white-space: nowrap;
}

.paseo-table th:last-child, .paseo-table td:last-child {
  border-right: 0;
}

.paseo-table tr:last-child td {
  border-bottom: 0;
}

.paseo-markdown ul, .paseo-markdown ol {
  margin: ${spacing[2]}px 0;
  padding: 0;
}

.paseo-markdown li {
  list-style: none;
  display: flex;
  align-items: flex-start;
  margin-bottom: ${spacing[1]}px;
}

.paseo-markdown ul > li::before {
  content: "•";
  color: ${colors.foregroundMuted};
  margin-right: 4px;
  line-height: 22px;
}

.paseo-markdown ol {
  counter-reset: paseoItem;
}

.paseo-markdown ol > li {
  counter-increment: paseoItem;
}

.paseo-markdown ol > li::before {
  content: counter(paseoItem) ".";
  color: ${colors.foregroundMuted};
  margin-right: 4px;
  font-weight: ${fontWeight.semibold};
  line-height: 22px;
  min-width: 12px;
}

.paseo-markdown blockquote {
  background: ${colors.surface2};
  border-left: 4px solid ${colors.primary};
  padding: ${spacing[3]}px ${spacing[4]}px;
  margin: ${spacing[3]}px 0;
  border-radius: ${borderRadius.md}px;
}

.paseo-markdown hr {
  border: 0;
  height: 1px;
  background: ${colors.border};
  margin: ${spacing[6]}px 0;
}
`;
  }, [theme]);

  const html = useMemo(() => renderAssistantMarkdownHtml(markdown), [markdown]);

  const handleClick = useCallback(
    (event: any) => {
      const target = event?.target as HTMLElement | null;
      if (!target) {
        return;
      }

      const pathEl = target.closest?.("[data-inline-path]") as HTMLElement | null;
      if (pathEl) {
        const raw = pathEl.getAttribute("data-inline-path") ?? "";
        const parsed = parseInlinePathToken(raw);
        if (parsed) {
          event.preventDefault?.();
          void onInlinePathPressAsync?.(parsed);
        }
        return;
      }

      const linkEl = target.closest?.("a") as HTMLAnchorElement | null;
      if (linkEl?.href) {
        event.preventDefault?.();
        void onLinkPressAsync?.(linkEl.href);
      }
    },
    [onInlinePathPressAsync, onLinkPressAsync]
  );

  useEffect(() => {
    if (!onHeightChangeAsync) {
      return;
    }

    let rafId: number | null = null;
    let intervalId: number | null = null;
    const report = () => {
      if (rafId != null) {
        return;
      }
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        const height = Math.ceil(
          Math.max(
            document.documentElement.scrollHeight,
            document.body?.scrollHeight ?? 0
          )
        );

        if (Math.abs(height - lastReportedHeightRef.current) <= 1) {
          return;
        }

        lastReportedHeightRef.current = height;
        void onHeightChangeAsync(height);
      });
    };

    report();

    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(report);
      ro.observe(document.documentElement);
      if (document.body) {
        ro.observe(document.body);
      }

      window.addEventListener("load", report);

      return () => {
        window.removeEventListener("load", report);
        ro.disconnect();
        if (rafId != null) {
          window.cancelAnimationFrame(rafId);
        }
      };
    }

    window.addEventListener("load", report);
    intervalId = window.setInterval(report, 250);

    return () => {
      window.removeEventListener("load", report);
      if (intervalId != null) {
        window.clearInterval(intervalId);
      }
      if (rafId != null) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [onHeightChangeAsync, markdown, cssText]);

  return (
    <div className="paseo-markdown" onClick={handleClick}>
      <style dangerouslySetInnerHTML={{ __html: cssText }} />
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
