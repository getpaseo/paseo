import { Check, Copy, FileText } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

interface DocsMarkdownActionsProps {
  content: string;
  markdownHref: string;
}

export function DocsMarkdownActions({ content, markdownHref }: DocsMarkdownActionsProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);

  const onCopy = useCallback(() => {
    navigator.clipboard.writeText(content).then(() => setCopied(true));
  }, [content]);

  return (
    <div className="not-prose flex flex-wrap items-center gap-2 mb-8">
      <button
        type="button"
        onClick={onCopy}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
        {copied ? "Copied" : "Copy as markdown"}
      </button>
      <a
        href={markdownHref}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
      >
        <FileText size={14} />
        View as markdown
      </a>
    </div>
  );
}
