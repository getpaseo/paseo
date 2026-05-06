import * as React from "react";

interface CodeBlockProps {
  children: string;
  size?: "sm" | "md";
}

const SIZE_PADDING: Record<NonNullable<CodeBlockProps["size"]>, string> = {
  sm: "px-3 py-2",
  md: "p-3 md:p-4",
};

export function CodeBlock({ children, size = "md" }: CodeBlockProps) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = React.useCallback(() => {
    navigator.clipboard.writeText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [children]);

  return (
    <div
      className={`bg-black/30 backdrop-blur-sm rounded-lg ${SIZE_PADDING[size]} font-mono text-sm flex items-center justify-between gap-2`}
    >
      <div>
        <span className="text-muted-foreground select-none">$ </span>
        <span className="text-foreground">{children}</span>
      </div>
      <button
        type="button"
        onClick={handleCopy}
        className="text-muted-foreground hover:text-foreground transition-colors p-1"
        title="Copy to clipboard"
      >
        {copied ? (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            fill="currentColor"
            viewBox="0 0 256 256"
          >
            <path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z" />
          </svg>
        ) : (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            fill="currentColor"
            viewBox="0 0 256 256"
          >
            <path d="M216,28H88A20,20,0,0,0,68,48V76H40A20,20,0,0,0,20,96V216a20,20,0,0,0,20,20H168a20,20,0,0,0,20-20V188h28a20,20,0,0,0,20-20V48A20,20,0,0,0,216,28ZM164,212H44V100H164Zm48-48H188V96a20,20,0,0,0-20-20H92V52H212Z" />
          </svg>
        )}
      </button>
    </div>
  );
}
