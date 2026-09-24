import React, {
  Children,
  Fragment,
  isValidElement,
  useCallback,
  useMemo,
  type ComponentProps,
  type MouseEvent,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import { useAppSettings } from "@/hooks/use-settings";
import { fenceLanguageToExtension } from "@/utils/fence-language";
import { highlightToKeyedLines } from "@/utils/highlight-cache";
import { openExternalUrl } from "@/utils/open-external-url";
import { parseMarkdownPreviewDocument } from "./document";
import "./markdown-preview.web.css";

type MarkdownPlugins = NonNullable<ComponentProps<typeof ReactMarkdown>["remarkPlugins"]>;

const REMARK_PLUGINS: MarkdownPlugins = [remarkGfm];

const REHYPE_PLUGINS: MarkdownPlugins = [
  rehypeSlug,
  [
    rehypeAutolinkHeadings,
    {
      behavior: "prepend",
      properties: { className: "paseo-md-anchor", ariaHidden: "true", tabIndex: -1 },
      content: {
        type: "element",
        tagName: "span",
        properties: { className: "paseo-md-anchor-icon" },
        children: [{ type: "text", value: "#" }],
      },
    },
  ],
];

function MarkdownLink({
  href,
  children,
  node: _node,
  ...props
}: ComponentProps<"a"> & { node?: unknown }) {
  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (!href || href.startsWith("#")) {
        return;
      }
      event.preventDefault();
      void openExternalUrl(href);
    },
    [href],
  );

  return (
    <a {...props} href={href} rel="noreferrer" target="_blank" onClick={handleClick}>
      {children}
    </a>
  );
}

function MarkdownTable({ node: _node, ...props }: ComponentProps<"table"> & { node?: unknown }) {
  return (
    <div className="paseo-md-table-scroll">
      <table {...props} />
    </div>
  );
}

function MarkdownPre({
  children,
  node: _node,
  ...props
}: ComponentProps<"pre"> & { node?: unknown }) {
  const codeElement = Children.toArray(children).find(
    (child) => isValidElement(child) && child.type === "code",
  );
  const codeProps = isValidElement<ComponentProps<"code">>(codeElement)
    ? codeElement.props
    : undefined;
  const code = Children.toArray(codeProps?.children).join("").replace(/\n$/, "");
  const language = codeProps?.className?.match(/language-([^\s]+)/)?.[1];
  const lines = useMemo(
    () => highlightToKeyedLines(code, fenceLanguageToExtension(language)),
    [code, language],
  );

  return (
    <pre {...props} data-pmono="">
      <code className={codeProps?.className} data-pmono="">
        {lines
          ? lines.map((line, lineIndex) => (
              <Fragment key={line.key}>
                {lineIndex > 0 ? "\n" : null}
                {line.tokens.map(({ key, token }) =>
                  token.style ? (
                    <span key={key} className={`paseo-md-tok-${token.style}`}>
                      {token.text}
                    </span>
                  ) : (
                    <Fragment key={key}>{token.text}</Fragment>
                  ),
                )}
              </Fragment>
            ))
          : code}
      </code>
    </pre>
  );
}

const COMPONENTS: Components = {
  a: MarkdownLink,
  pre: MarkdownPre,
  table: MarkdownTable,
};

export function MarkdownPreviewDocument({
  source,
  contentFontSize,
}: {
  source: string;
  contentFontSize: number;
}) {
  const document = useMemo(() => parseMarkdownPreviewDocument(source), [source]);
  const contentStyle = useMemo(() => ({ fontSize: `${contentFontSize}px` }), [contentFontSize]);

  return (
    <div className="paseo-md" style={contentStyle} data-testid="markdown-preview">
      {document.frontMatter.length > 0 ? (
        <table className="paseo-md-frontmatter">
          <tbody>
            {document.frontMatter.map((row) => (
              <tr key={row.key}>
                <th scope="row">{row.key}</th>
                <td>{row.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={COMPONENTS}
      >
        {document.body}
      </ReactMarkdown>
    </div>
  );
}

export function FileMarkdownPreview({ source }: { source: string }) {
  const { settings } = useAppSettings();
  return <MarkdownPreviewDocument source={source} contentFontSize={settings.contentFontSize} />;
}
