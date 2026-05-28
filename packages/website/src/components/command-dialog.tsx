import * as React from "react";
import { motion, AnimatePresence, type Transition } from "framer-motion";
import { CodeBlock } from "./code-block";

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
      <button type="button" aria-label={title} onClick={handleToggle}>
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
