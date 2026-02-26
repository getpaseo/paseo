import { memo, type ComponentType } from "react"
import { Streamdown, type Components, type ExtraProps } from "streamdown"
import { cn } from "@/lib/cn"

/**
 * Custom link component that opens URLs in a new tab.
 */
const LinkComponent: ComponentType<
  React.AnchorHTMLAttributes<HTMLAnchorElement> & ExtraProps
> = ({ href, children, node: _node, ...props }) => (
  <a
    href={href}
    target="_blank"
    rel="noopener noreferrer"
    className="text-primary underline underline-offset-2 hover:text-primary/80"
    {...props}
  >
    {children}
  </a>
)

const components: Components = {
  a: LinkComponent,
}

interface ChatMarkdownProps {
  content: string
  isStreaming?: boolean
  className?: string
}

export const ChatMarkdown = memo(function ChatMarkdown({
  content,
  isStreaming,
  className,
}: ChatMarkdownProps) {
  if (!content) return null

  return (
    <div
      className={cn(
        "prose prose-sm dark:prose-invert max-w-none",
        "prose-p:leading-relaxed prose-p:my-1.5",
        "prose-headings:mt-4 prose-headings:mb-2",
        "prose-pre:bg-muted/50 prose-pre:border prose-pre:border-border prose-pre:rounded-lg",
        "prose-code:text-[13px] prose-code:before:content-none prose-code:after:content-none",
        "prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded",
        "prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5",
        "prose-blockquote:border-l-primary/50 prose-blockquote:not-italic",
        "prose-table:text-sm",
        "prose-img:rounded-lg",
        "break-words",
        className,
      )}
    >
      <Streamdown
        mode={isStreaming ? "streaming" : "static"}
        parseIncompleteMarkdown={isStreaming}
        components={components}
      >
        {content}
      </Streamdown>
    </div>
  )
})
