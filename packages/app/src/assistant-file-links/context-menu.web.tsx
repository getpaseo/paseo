import { useState, type ReactNode, type MouseEvent, type KeyboardEvent } from "react";
import { ContextMenu, useContextMenu } from "@/components/ui/context-menu";
import { useStableEvent } from "@/hooks/use-stable-event";
import { FileLinkMenuContent } from "./menu-content";
import type { AssistantFileLinkSource } from "./resolver";

export function FileLinkContextMenu({
  source,
  enabled,
  children,
}: {
  source: AssistantFileLinkSource;
  enabled: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (!enabled) return children;
  return (
    <ContextMenu open={open} onOpenChange={setOpen}>
      <InlineMenuTrigger>{children}</InlineMenuTrigger>
      {open ? <FileLinkMenuContent source={source} /> : null}
    </ContextMenu>
  );
}

function InlineMenuTrigger({ children }: { children: ReactNode }) {
  const menu = useContextMenu();
  const open = useStableEvent(
    (event: MouseEvent<HTMLSpanElement> | KeyboardEvent<HTMLSpanElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const anchor = event.currentTarget.querySelector("a");
      anchor?.focus();
      const rect = event.currentTarget.getBoundingClientRect();
      const x = "pageX" in event ? event.pageX : rect.left;
      const y = "pageY" in event ? event.pageY : rect.bottom;
      menu.setAnchorRect({ x, y, width: 0, height: 0 });
      menu.setOpen(true);
    },
  );
  const keyDown = useStableEvent((event: KeyboardEvent<HTMLSpanElement>) => {
    const contextKey = event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
    if (contextKey) open(event);
  });
  return (
    <span onContextMenu={open} onKeyDown={keyDown}>
      {children}
    </span>
  );
}
