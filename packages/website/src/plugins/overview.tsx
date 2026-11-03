import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { pluginOverviewPolicy, pluginOverviewUrl } from "@getpaseo/protocol/plugin-overview";
import type { Locale } from "~/i18n";

/** A rejected destination leaves its label as text, without even an empty anchor. */
export function PluginContentLink({
  href,
  children,
  className,
}: {
  href?: string;
  children: ReactNode;
  className?: string;
}) {
  const destination = pluginOverviewUrl(href);
  return destination ? (
    <a href={destination} {...pluginOverviewPolicy.link} className={className}>
      {children}
    </a>
  ) : (
    children
  );
}

const allowedElements = [...pluginOverviewPolicy.elements];
const remarkPlugins = [remarkGfm];

const components: Components = {
  a: ({ href, children }) => <PluginContentLink href={href}>{children}</PluginContentLink>,
  img: ({ src, alt }) => {
    const source = pluginOverviewUrl(typeof src === "string" ? src : undefined);
    return source ? <img src={source} alt={alt ?? ""} loading="lazy" /> : alt;
  },
  // GFM alignment otherwise becomes an inline style in react-markdown.
  th: ({ children }) => <th>{children}</th>,
  td: ({ children }) => <td>{children}</td>,
};

/** Untrusted overviews do not inherit documentation directives, anchors, or HTML highlighters. */
export function PluginOverview({ children, lang }: { children: string; lang: Locale }) {
  return (
    <div className="docs-prose" lang={lang}>
      <ReactMarkdown
        skipHtml={!pluginOverviewPolicy.rawHtml}
        allowedElements={allowedElements}
        unwrapDisallowed
        remarkPlugins={remarkPlugins}
        urlTransform={pluginOverviewUrl}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
