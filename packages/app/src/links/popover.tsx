import { useCallback, useLayoutEffect, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Copy, ExternalLink, Globe, Settings } from "lucide-react-native";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  useContextMenu,
} from "@/components/ui/context-menu";
import { menuRowContentInset } from "@/components/ui/menu";
import { ToolbarButton, paneContentToolbarIconSize } from "@/components/ui/pane-content-toolbar";
import { Shortcut } from "@/components/ui/shortcut";
import { extraMutedIconColorMapping, mutedIconColorMapping } from "@/components/ui/icon-color";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import { buildSettingsSectionRoute } from "@/utils/host-routes";
import { formatLinkAddress } from "./link-address";

const ThemedCopy = withUnistyles(Copy);
const ThemedExternalLink = withUnistyles(ExternalLink);
const ThemedGlobe = withUnistyles(Globe);
const ThemedSettings = withUnistyles(Settings);

const MENU_WIDTH = 280;
const MENU_ICON_SIZE = 16;

const NEW_TAB_ICON = <ThemedGlobe size={MENU_ICON_SIZE} uniProps={mutedIconColorMapping} />;
const DEFAULT_BROWSER_ICON = (
  <ThemedExternalLink size={MENU_ICON_SIZE} uniProps={mutedIconColorMapping} />
);
const COPY_ICON = <ThemedCopy size={MENU_ICON_SIZE} uniProps={mutedIconColorMapping} />;
const SETTINGS_ICON = (
  <ThemedSettings size={paneContentToolbarIconSize(false)} uniProps={extraMutedIconColorMapping} />
);

/** A link the user clicked, and the viewport point the popover anchors to. */
export interface LinkPopoverTarget {
  url: string;
  x: number;
  y: number;
}

interface LinkPopoverProps {
  target: LinkPopoverTarget | null;
  onClose: () => void;
  onOpenInPaseoBrowser: (url: string) => void;
  onOpenInSystemBrowser: (url: string) => void;
}

export function LinkPopover({
  target,
  onClose,
  onOpenInPaseoBrowser,
  onOpenInSystemBrowser,
}: LinkPopoverProps) {
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) onClose();
    },
    [onClose],
  );
  return (
    <ContextMenu compactMode="popover" open={target !== null} onOpenChange={handleOpenChange}>
      {target ? (
        <LinkPopoverSurface
          target={target}
          onOpenInPaseoBrowser={onOpenInPaseoBrowser}
          onOpenInSystemBrowser={onOpenInSystemBrowser}
        />
      ) : null}
    </ContextMenu>
  );
}

function LinkPopoverSurface({
  target,
  onOpenInPaseoBrowser,
  onOpenInSystemBrowser,
}: {
  target: LinkPopoverTarget;
  onOpenInPaseoBrowser: (url: string) => void;
  onOpenInSystemBrowser: (url: string) => void;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const { setAnchorRect, setOpen } = useContextMenu();
  const { url } = target;

  // The menu's anchor lives in its own state; it follows each new click.
  useLayoutEffect(() => {
    setAnchorRect({ x: target.x, y: target.y, width: 0, height: 0 });
  }, [setAnchorRect, target]);

  const copyLink = useCallback(() => void copyToClipboard(url), [url]);
  const openInPaseoBrowser = useCallback(
    () => onOpenInPaseoBrowser(url),
    [onOpenInPaseoBrowser, url],
  );
  const openInSystemBrowser = useCallback(
    () => onOpenInSystemBrowser(url),
    [onOpenInSystemBrowser, url],
  );
  const openSettings = useCallback(() => {
    setOpen(false);
    router.push(buildSettingsSectionRoute("general"));
  }, [router, setOpen]);

  const click = t("linkPopover.click");
  const newTabShortcut = useMemo(() => <Shortcut keys={["mod", click]} />, [click]);
  const defaultBrowserShortcut = useMemo(
    () => <Shortcut keys={["shift", "mod", click]} />,
    [click],
  );
  return (
    <ContextMenuContent width={MENU_WIDTH} testID="link-popover">
      <ContextMenuItem
        leading={NEW_TAB_ICON}
        trailing={newTabShortcut}
        testID="link-popover-paseo-browser"
        onSelect={openInPaseoBrowser}
      >
        {t("linkPopover.openInNewTab")}
      </ContextMenuItem>
      <ContextMenuItem
        leading={DEFAULT_BROWSER_ICON}
        trailing={defaultBrowserShortcut}
        testID="link-popover-system-browser"
        onSelect={openInSystemBrowser}
      >
        {t("linkPopover.openInDefaultBrowser")}
      </ContextMenuItem>
      <ContextMenuItem leading={COPY_ICON} testID="link-popover-copy" onSelect={copyLink}>
        {t("linkPopover.copyLink")}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <View style={styles.footer}>
        <Text style={styles.address} numberOfLines={1} ellipsizeMode="middle" selectable>
          {formatLinkAddress(url)}
        </Text>
        <ToolbarButton
          label={t("linkPopover.settings")}
          testID="link-popover-settings"
          onPress={openSettings}
        >
          {SETTINGS_ICON}
        </ToolbarButton>
      </View>
    </ContextMenuContent>
  );
}

const styles = StyleSheet.create((theme) => ({
  // The address sits on the rows' label rail; the gear ends on the surface's trailing inset.
  footer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: menuRowContentInset(theme),
    paddingRight: theme.spacing[1],
  },
  address: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
