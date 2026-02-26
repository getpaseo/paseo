import * as React from "react"
import { cn } from "@/lib/cn"
import { CmdIcon, EnterIcon, OptionIcon, ShiftIcon } from "./icons"

export interface KbdProps extends React.HTMLAttributes<HTMLElement> {}

/** Parse shortcut string and replace modifier symbols with icons */
function renderShortcut(children: React.ReactNode): React.ReactNode {
  if (typeof children !== "string") return children

  const parts: React.ReactNode[] = []

  // Map of symbols to icons (3 = 12px to match text-xs visually)
  const symbolMap: Record<string, React.ReactNode> = {
    "\u2318": <CmdIcon key="cmd" className="h-3 w-3" />,
    "\u2325": <OptionIcon key="opt" className="h-3 w-3" />,
    "\u21E7": <ShiftIcon key="shift" className="h-3 w-3" />,
    "\u2303": <span key="ctrl">{"\u2303"}</span>, // Control stays as unicode (no icon)
    "\u21B5": <EnterIcon key="enter" className="h-3 w-3" />,
  }

  // Split by symbols and replace with icons
  const regex = /([\u2318\u2325\u21E7\u2303\u21B5])/g
  const tokens = children.split(regex)

  tokens.forEach((token, index) => {
    if (symbolMap[token]) {
      parts.push(symbolMap[token])
    } else if (token) {
      parts.push(<span key={index}>{token}</span>)
    }
  })

  return parts
}

const Kbd = React.forwardRef<HTMLElement, KbdProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <kbd
        ref={ref}
        className={cn(
          "pointer-events-none inline-flex items-center gap-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground/60",
          className,
        )}
        {...props}
      >
        {renderShortcut(children)}
      </kbd>
    )
  },
)
Kbd.displayName = "Kbd"

export { Kbd }
