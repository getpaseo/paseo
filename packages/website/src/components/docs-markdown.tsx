import * as React from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { useTranslation } from "react-i18next";
import { openEnclosingExamples } from "~/docs-example-target";
import { type Locale, localizePath, useLocale } from "~/i18n";
import { getDocsHighlighter, docsRehypePlugins, docsRemarkPlugins } from "~/docs-rehype";

function getCodeText(children: React.ReactNode): string {
  return React.Children.toArray(children).join("");
}

function getLanguage(className: string | undefined): string | undefined {
  return className?.match(/language-([^\s]+)/)?.[1];
}

function DocsPre({
  children,
  node: _node,
  ...props
}: React.ComponentProps<"pre"> & { node?: unknown }) {
  const codeElement = React.Children.only(children);
  const codeProps = React.isValidElement<React.ComponentProps<"code">>(codeElement)
    ? codeElement.props
    : undefined;
  const code = getCodeText(codeProps?.children);
  const language = getLanguage(codeProps?.className);
  const [highlightedHtml, setHighlightedHtml] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;

    setHighlightedHtml(null);
    if (!language) return;
    const lang = language;

    async function highlight() {
      try {
        const highlighter = await getDocsHighlighter();
        if (cancelled) return;
        setHighlightedHtml(
          highlighter.codeToHtml(code.replace(/\n$/, ""), {
            lang,
            theme: "catppuccin-mocha",
          }),
        );
      } catch {
        if (!cancelled) setHighlightedHtml(null);
      }
    }

    void highlight();

    return () => {
      cancelled = true;
    };
  }, [code, language]);

  const highlightedMarkup = React.useMemo(
    () => (highlightedHtml ? { __html: highlightedHtml } : undefined),
    [highlightedHtml],
  );

  if (highlightedMarkup) {
    return <div dangerouslySetInnerHTML={highlightedMarkup} />;
  }

  return <pre {...props}>{children}</pre>;
}

/** Links to other site pages stay in the reader's language; files and external URLs are unchanged. */
function markdownComponents(locale: Locale): Components {
  return {
    pre: DocsPre,
    a: ({ href, node: _node, ...props }) => (
      <a {...props} href={href === undefined ? undefined : localizePath(href, locale)} />
    ),
  };
}

// A collapsed example hides everything inside it, so a link to one scrolls to
// nothing until the block is open.
function revealHashTarget(): void {
  const id = window.location.hash.slice(1);
  if (!id) return;
  const target = document.getElementById(decodeURIComponent(id));
  if (!target) return;
  openEnclosingExamples(target);
  target.scrollIntoView();
}

function useHashTarget(content: string): void {
  React.useEffect(() => {
    const frame = window.requestAnimationFrame(revealHashTarget);
    window.addEventListener("hashchange", revealHashTarget);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("hashchange", revealHashTarget);
    };
  }, [content]);
}

/** Renders Markdown written in `lang`, which differs from the page's language for a fallback. */
export function DocsMarkdown({ children, lang }: { children: string; lang: Locale }) {
  useHashTarget(children);
  const { t } = useTranslation();
  const locale = useLocale();
  const anchorLabel = t("docs.headingAnchor");
  const rehypePlugins = React.useMemo(() => docsRehypePlugins(anchorLabel), [anchorLabel]);
  const components = React.useMemo(() => markdownComponents(locale), [locale]);

  return (
    <div className="docs-prose" lang={lang}>
      <ReactMarkdown
        remarkPlugins={docsRemarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
