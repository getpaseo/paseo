import { useState, type ReactNode } from "react";
import { View } from "react-native";
import type { LinkPressEvent } from "react-native-enriched-markdown";
import { ContextMenu, useContextMenu } from "@/components/ui/context-menu";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useAssistantFileLinkActions } from "./use-file-link";
import type { AssistantFileLinkSource } from "./resolver";
import { FileLinkMenuContent } from "./menu-content";

export interface FileLinkLongPressMenuProps {
  enabled: boolean;
  linkSource: (url: string, sourceType?: LinkPressEvent["sourceType"]) => AssistantFileLinkSource;
  children: (onLongPress: ((event: LinkPressEvent) => void) | undefined) => ReactNode;
}

export function FileLinkLongPressMenu(props: FileLinkLongPressMenuProps) {
  return (
    <ContextMenu>
      <NativeMenu {...props} />
    </ContextMenu>
  );
}

function NativeMenu({ enabled, linkSource, children }: FileLinkLongPressMenuProps) {
  const menu = useContextMenu();
  const actions = useAssistantFileLinkActions();
  const [source, setSource] = useState<AssistantFileLinkSource | null>(null);
  const onLongPress = useStableEvent(({ url, sourceType }: LinkPressEvent) => {
    const next = linkSource(url, sourceType);
    if (!actions.canResolveFile(next)) return;
    setSource(next);
    menu.setOpen(true);
  });
  return (
    <>
      <View ref={menu.triggerRef} collapsable={false}>
        {children(enabled ? onLongPress : undefined)}
      </View>
      {menu.open && source ? (
        <FileLinkMenuContent source={source} key={`${source.sourceType}:${source.href}`} />
      ) : null}
    </>
  );
}
