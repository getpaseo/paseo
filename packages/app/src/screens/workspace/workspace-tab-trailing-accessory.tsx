import { useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  Copy,
  CopyX,
  Ellipsis,
  Pencil,
  RotateCw,
  X,
} from "lucide-react-native";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { WorkspaceTabMenuEntry } from "@/screens/workspace/workspace-tab-menu";
import type { Theme } from "@/styles/theme";

const ThemedEllipsis = withUnistyles(Ellipsis);
const ThemedCopy = withUnistyles(Copy);
const ThemedRotateCw = withUnistyles(RotateCw);
const ThemedArrowLeftToLine = withUnistyles(ArrowLeftToLine);
const ThemedArrowRightToLine = withUnistyles(ArrowRightToLine);
const ThemedCopyX = withUnistyles(CopyX);
const ThemedPencil = withUnistyles(Pencil);
const ThemedX = withUnistyles(X);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function mobileTabMenuTriggerStyle({ open, pressed }: { open?: boolean; pressed?: boolean }) {
  return [
    styles.mobileTabMenuTrigger,
    (Boolean(open) || Boolean(pressed)) && styles.mobileTabMenuTriggerActive,
  ];
}

function MobileTabDropdownMenuItem({
  entry,
}: {
  entry: Extract<WorkspaceTabMenuEntry, { kind: "item" }>;
}) {
  const leading = useMemo(() => {
    switch (entry.icon) {
      case "copy":
        return <ThemedCopy size={16} uniProps={mutedColorMapping} />;
      case "rotate-cw":
        return <ThemedRotateCw size={16} uniProps={mutedColorMapping} />;
      case "arrow-left-to-line":
        return <ThemedArrowLeftToLine size={16} uniProps={mutedColorMapping} />;
      case "arrow-right-to-line":
        return <ThemedArrowRightToLine size={16} uniProps={mutedColorMapping} />;
      case "copy-x":
        return <ThemedCopyX size={16} uniProps={mutedColorMapping} />;
      case "pencil":
        return <ThemedPencil size={16} uniProps={mutedColorMapping} />;
      case "x":
        return <ThemedX size={16} uniProps={mutedColorMapping} />;
      default:
        return undefined;
    }
  }, [entry.icon]);
  const trailing = useMemo(
    () => (entry.hint ? <Text style={styles.menuItemHint}>{entry.hint}</Text> : undefined),
    [entry.hint],
  );
  return (
    <DropdownMenuItem
      testID={entry.testID}
      disabled={entry.disabled}
      destructive={entry.destructive}
      onSelect={entry.onSelect}
      tooltip={entry.tooltip}
      leading={leading}
      trailing={trailing}
    >
      {entry.label}
    </DropdownMenuItem>
  );
}

export function MobileTabTrailingAccessory({
  menuTestIDBase,
  presentationLabel,
  menuEntries,
}: {
  menuTestIDBase: string;
  presentationLabel: string;
  menuEntries: WorkspaceTabMenuEntry[];
}): ReactElement {
  const { t } = useTranslation();
  return (
    <DropdownMenu compactMode="sheet">
      <DropdownMenuTrigger
        testID={`${menuTestIDBase}-trigger`}
        accessibilityRole="button"
        accessibilityLabel={t("workspace.tabs.menu.openFor", { label: presentationLabel })}
        hitSlop={8}
        style={mobileTabMenuTriggerStyle}
      >
        <ThemedEllipsis size={14} uniProps={mutedColorMapping} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="end"
        width={220}
        sheetTitle={presentationLabel}
        testID={menuTestIDBase}
      >
        {menuEntries.map((entry) =>
          entry.kind === "separator" ? (
            <DropdownMenuSeparator key={entry.key} />
          ) : (
            <MobileTabDropdownMenuItem key={entry.key} entry={entry} />
          ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const styles = StyleSheet.create((theme) => ({
  mobileTabMenuTrigger: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  mobileTabMenuTriggerActive: {
    backgroundColor: theme.colors.surface2,
  },
  menuItemHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));
