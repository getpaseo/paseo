import * as React from "react";
import { motion, AnimatePresence, type Transition } from "framer-motion";

const OVERLAY_INITIAL = { opacity: 0 };
const OVERLAY_ANIMATE = { opacity: 1 };
const OVERLAY_EXIT = { opacity: 0 };
const OVERLAY_TRANSITION: Transition = { duration: 0.2 };

const PANEL_INITIAL = { opacity: 0, scale: 0.95 };
const PANEL_ANIMATE = { opacity: 1, scale: 1 };
const PANEL_EXIT = { opacity: 0, scale: 0.95 };
const PANEL_TRANSITION: Transition = { duration: 0.2, ease: "easeOut" };

interface CommandDialogProps {
  trigger: React.ReactNode;
  title: string;
  description?: string;
  command: string;
  footnote?: React.ReactNode;
}

export function CommandDialog({
  trigger,
  title,
  description,
  command,
  footnote,
}: CommandDialogProps) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  const handleToggle = React.useCallback(() => setOpen((prev) => !prev), []);
  const handleClose = React.useCallback(() => setOpen(false), []);

  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={handleToggle}>
        {trigger}
      </button>
      <AnimatePresence>
        {open && (
          <>
            <motion.div
              initial={OVERLAY_INITIAL}
              animate={OVERLAY_ANIMATE}
              exit={OVERLAY_EXIT}
              transition={OVERLAY_TRANSITION}
              className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
              onClick={handleClose}
            />
            <motion.div
              initial={PANEL_INITIAL}
              animate={PANEL_ANIMATE}
              exit={PANEL_EXIT}
              transition={PANEL_TRANSITION}
              className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-md rounded-xl border border-white/20 bg-background p-6 space-y-4"
            >
              <div className="space-y-2">
                <p className="text-base font-medium text-white">{title}</p>
                {description && <p className="text-sm text-muted-foreground">{description}</p>}
              </div>
              <CodeBlock>{command}</CodeBlock>
              {footnote && <p className="text-xs text-white/30">{footnote}</p>}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

function CodeBlock({ children }: { children: string }) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = React.useCallback(() => {
    navigator.clipboard.writeText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [children]);

  return (
    <div className="bg-black/30 backdrop-blur-sm rounded-lg p-3 md:p-4 font-mono text-sm flex items-center justify-between gap-2">
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
