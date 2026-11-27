import {
  createContext,
  useContext,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import type { GestureResponderEvent } from "react-native";
import { ContextMenu, useContextMenu } from "@/components/ui/context-menu";
import { isWeb } from "@/constants/platform";
import { useStableEvent } from "@/hooks/use-stable-event";
import { LinkMenuSurface } from "./internal/surface";
import type { LinkMenuLink, LinkMenuSubject, OpenedLink, Point } from "./internal/types";

export type { LinkMenuSubject } from "./internal/types";

/** Opens the menu for a link. False when the link has none, so the platform's own menu stays. */
type OpenLinkMenu = (link: LinkMenuLink, point: Point) => boolean;

const LinkMenuContext = createContext<OpenLinkMenu | null>(null);

export function useOpenLinkMenu(): OpenLinkMenu | null {
  return useContext(LinkMenuContext);
}

/** One menu for every link in a piece of Markdown. Adds no view of its own. */
export function LinkMenu({
  describeLink,
  children,
}: {
  describeLink: (link: LinkMenuLink) => LinkMenuSubject | null;
  children: ReactNode;
}) {
  const [opened, setOpened] = useState<OpenedLink | null>(null);
  // The surface holds its workspace's hooks, so it lives only as long as the menu is open.
  const handleOpenChange = useStableEvent((open: boolean) => {
    if (!open) setOpened(null);
  });
  return (
    <ContextMenu onOpenChange={handleOpenChange}>
      <LinkMenuHost describeLink={describeLink} setOpened={setOpened}>
        {children}
      </LinkMenuHost>
      {opened ? <LinkMenuSurface link={opened} /> : null}
    </ContextMenu>
  );
}

function LinkMenuHost({
  describeLink,
  setOpened,
  children,
}: {
  describeLink: (link: LinkMenuLink) => LinkMenuSubject | null;
  setOpened: Dispatch<SetStateAction<OpenedLink | null>>;
  children: ReactNode;
}) {
  const menu = useContextMenu();

  const open = useStableEvent((link: LinkMenuLink, point: Point) => {
    const subject = describeLink(link);
    if (!subject) return false;
    if (subject.kind === "web") {
      setOpened(subject);
    } else {
      // The menu opens on what the link says and settles on what the host finds.
      const lookup = subject.inspection.lookup();
      setOpened({ ...subject, lookup, found: null });
      void lookup.then((found) =>
        setOpened((current) =>
          current?.kind === "path" && current.lookup === lookup ? { ...current, found } : current,
        ),
      );
    }
    menu.setAnchorRect({ ...point, width: 0, height: 0 });
    menu.setOpen(true);
    return true;
  });

  return <LinkMenuContext.Provider value={open}>{children}</LinkMenuContext.Provider>;
}

/**
 * Long press on a link, for the native text view. Web links open the menu themselves, from their
 * own right click.
 */
export function useLinkMenuLongPress(markdown: string) {
  const open = useOpenLinkMenu();
  // The native event carries no position; the touch that started the press does.
  const touch = useRef<Point>({ x: 0, y: 0 });
  const onTouchStart = useStableEvent((event: GestureResponderEvent) => {
    touch.current = { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY };
  });
  const onLinkLongPress = useStableEvent(({ url }: { url: string }) => {
    // Nor does it say how the link was written. One that is no `](destination)` was recognized
    // in the text.
    open?.({ url, sourceType: markdown.includes(`](${url}`) ? "markdown" : "text" }, touch.current);
  });
  return useMemo(
    () => (isWeb ? null : { onTouchStart, onLinkLongPress }),
    [onTouchStart, onLinkLongPress],
  );
}
