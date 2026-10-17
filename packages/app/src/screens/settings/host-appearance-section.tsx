import { useCallback, useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Pencil } from "lucide-react-native";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import { WorkspaceMetaRow } from "@/components/sidebar/workspace-meta-row";
import { useToast } from "@/contexts/toast-context";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import {
  DEFAULT_HOST_ICON,
  HOST_BADGE_DISPLAYS,
  HOST_COLORS,
  HOST_ICONS,
  detectedHostIcon,
  resolveHostBadgeDisplay,
  resolveHostIcon,
  type HostBadgeDisplay,
  type HostColor,
  type HostIcon,
} from "@/hosts/appearance";
import { useHostFeature } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";
import { THEMED_HOST_ICONS } from "@/hosts/host-icon";
import { useLocalDaemonServerIdState } from "@/hooks/use-is-local-daemon";
import {
  useHostMutations,
  useHostRuntimeClient,
  useHostRuntimeIsConnected,
} from "@/runtime/host-runtime";
import { identityColor } from "@/styles/identity-colors";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import type { HostProfile } from "@/types/host-connection";

const ThemedPencil = withUnistyles(Pencil);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function HostRenameButton({ host }: { host: HostProfile }) {
  const { t } = useTranslation();
  const { renameHost } = useHostMutations();
  const [isEditing, setIsEditing] = useState(false);

  const handleSubmit = useCallback(
    async (value: string) => {
      const nextLabel = value.trim();
      if (nextLabel === host.label.trim()) return;
      await renameHost(host.serverId, nextLabel);
    },
    [host.label, host.serverId, renameHost],
  );

  const openEditor = useCallback(() => setIsEditing(true), []);
  const closeEditor = useCallback(() => setIsEditing(false), []);

  return (
    <>
      <Pressable
        onPress={openEditor}
        hitSlop={8}
        style={styles.renameButton}
        accessibilityRole="button"
        accessibilityLabel={t("settings.host.daemon.rename.editLabel")}
        testID="host-page-label-edit-button"
      >
        <ThemedPencil size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
      </Pressable>

      <AdaptiveRenameModal
        visible={isEditing}
        title={t("settings.host.daemon.rename.title")}
        initialValue={host.label}
        placeholder={t("settings.host.daemon.rename.placeholder")}
        submitLabel={t("settings.host.daemon.rename.submit")}
        onClose={closeEditor}
        onSubmit={handleSubmit}
        testID="host-page-rename-modal"
      />
    </>
  );
}

function colorLabel(t: TFunction, color: HostColor): string {
  return t(`settings.host.appearance.color.options.${color}`);
}

function iconLabel(t: TFunction, icon: HostIcon): string {
  return t(`settings.host.appearance.icon.options.${icon}`);
}

function badgeDisplayLabel(t: TFunction, display: HostBadgeDisplay): string {
  return t(`settings.host.appearance.badge.options.${display}`);
}

function ColorSwatch({ color }: { color: HostColor }) {
  const swatchStyle = useMemo(
    () => [styles.swatch, color === "none" ? null : { backgroundColor: identityColor(color) }],
    [color],
  );
  return <View style={swatchStyle} />;
}

function ColorMenuItem({
  color,
  selected,
  onChange,
}: {
  color: HostColor;
  selected: boolean;
  onChange: (color: HostColor) => void;
}) {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => onChange(color), [color, onChange]);
  const leading = useMemo(() => <ColorSwatch color={color} />, [color]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect} leading={leading}>
      {colorLabel(t, color)}
    </DropdownMenuItem>
  );
}

function ColorRow({ color, onChange }: { color: HostColor; onChange: (color: HostColor) => void }) {
  const { t } = useTranslation();
  const selectedLabel = colorLabel(t, color);
  const leading = useMemo(() => <ColorSwatch color={color} />, [color]);
  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{t("settings.host.appearance.color.label")}</Text>
      </View>
      <DropdownMenu>
        <DropdownTrigger
          accessibilityRole="button"
          accessibilityLabel={t("settings.host.appearance.color.accessibilityLabel", {
            value: selectedLabel,
          })}
          leading={leading}
        >
          {selectedLabel}
        </DropdownTrigger>
        <DropdownMenuContent side="bottom" align="end" width={200}>
          {HOST_COLORS.map((option) => (
            <ColorMenuItem
              key={option}
              color={option}
              selected={option === color}
              onChange={onChange}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

function HostIconGlyph({ icon }: { icon: HostIcon }) {
  const ThemedIcon = THEMED_HOST_ICONS[icon];
  return <ThemedIcon size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
}

function IconMenuItem({
  icon,
  selected,
  detected,
  onChange,
}: {
  icon: HostIcon;
  selected: boolean;
  detected: boolean;
  onChange: (icon: HostIcon) => void;
}) {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => onChange(icon), [icon, onChange]);
  const leading = useMemo(() => <HostIconGlyph icon={icon} />, [icon]);
  return (
    <DropdownMenuItem
      selected={selected}
      onSelect={handleSelect}
      leading={leading}
      description={detected ? t("settings.host.appearance.icon.detected") : undefined}
      testID={`host-appearance-icon-option-${icon}`}
    >
      {iconLabel(t, icon)}
    </DropdownMenuItem>
  );
}

/**
 * The host's icon lives on its daemon, so every device draws the host the same way. Picking the
 * icon the daemon detected clears the choice, which lets a later, better guess take over.
 */
function IconRow({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supportsHostIcon = useHostFeature(serverId, "hostIcon");
  const info = useSessionStore((state) => state.sessions[serverId]?.serverInfo?.hostIcon);
  const icon = resolveHostIcon(info);
  const detected = detectedHostIcon(info);
  const selectedLabel = iconLabel(t, icon);
  const leading = useMemo(() => <HostIconGlyph icon={icon} />, [icon]);

  const handleChange = useCallback(
    async (next: HostIcon) => {
      if (!client) return;
      try {
        await client.patchDaemonConfig({
          hostIcon: next === (detected ?? DEFAULT_HOST_ICON) ? null : next,
        });
      } catch {
        toast.error(t("errors.unableToSave"));
      }
    },
    [client, detected, t, toast],
  );

  const unavailableHint = isConnected
    ? t("settings.host.appearance.icon.updateHost")
    : t("settings.host.appearance.icon.connectHost");
  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{t("settings.host.appearance.icon.label")}</Text>
        {isConnected && supportsHostIcon ? null : (
          <Text style={settingsStyles.rowHint}>{unavailableHint}</Text>
        )}
      </View>
      <DropdownMenu>
        <DropdownTrigger
          disabled={!isConnected || !supportsHostIcon}
          testID="host-appearance-icon"
          accessibilityRole="button"
          accessibilityLabel={t("settings.host.appearance.icon.accessibilityLabel", {
            value: selectedLabel,
          })}
          leading={leading}
        >
          {selectedLabel}
        </DropdownTrigger>
        <DropdownMenuContent side="bottom" align="end" width={200}>
          {HOST_ICONS.map((option) => (
            <IconMenuItem
              key={option}
              icon={option}
              selected={option === icon}
              detected={option === detected}
              onChange={handleChange}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

function BadgeDisplayRow({
  badgeDisplay,
  onChange,
}: {
  badgeDisplay: HostBadgeDisplay;
  onChange: (badgeDisplay: HostBadgeDisplay) => void;
}) {
  const { t } = useTranslation();
  const selectedLabel = badgeDisplayLabel(t, badgeDisplay);
  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{t("settings.host.appearance.badge.label")}</Text>
      </View>
      <DropdownMenu>
        <DropdownTrigger
          testID="host-appearance-badge-display"
          accessibilityRole="button"
          accessibilityLabel={t("settings.host.appearance.badge.accessibilityLabel", {
            value: selectedLabel,
          })}
        >
          {selectedLabel}
        </DropdownTrigger>
        <DropdownMenuContent side="bottom" align="end" width={200}>
          {HOST_BADGE_DISPLAYS.map((option) => (
            <BadgeDisplayMenuItem
              key={option}
              display={option}
              selected={option === badgeDisplay}
              onChange={onChange}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

function BadgeDisplayMenuItem({
  display,
  selected,
  onChange,
}: {
  display: HostBadgeDisplay;
  selected: boolean;
  onChange: (display: HostBadgeDisplay) => void;
}) {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => onChange(display), [display, onChange]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      {badgeDisplayLabel(t, display)}
    </DropdownMenuItem>
  );
}

/**
 * Shows the badge exactly as the sidebar will draw it, next to a sample workspace title on
 * the sidebar surface. The real component, never a restyled copy — a preview that can drift
 * from the thing it previews is worse than no preview.
 */
function BadgePreview({
  host,
  badgeDisplay,
}: {
  host: HostProfile;
  badgeDisplay: HostBadgeDisplay;
}) {
  const { t } = useTranslation();
  const icon = useSessionStore((state) =>
    resolveHostIcon(state.sessions[host.serverId]?.serverInfo?.hostIcon),
  );
  const hostBadge = useMemo(
    () =>
      badgeDisplay === "hidden"
        ? null
        : {
            serverId: host.serverId,
            label: host.label,
            color: host.appearance.color,
            icon,
            showLabel: badgeDisplay === "name",
          },
    [badgeDisplay, host.serverId, host.label, host.appearance.color, icon],
  );
  // The real sidebar row, so the preview can't drift from what the setting actually does.
  return (
    <View style={styles.preview} testID="host-appearance-preview">
      <Text style={styles.previewTitle} numberOfLines={1}>
        {t("settings.host.appearance.preview.workspaceName")}
      </Text>
      <WorkspaceMetaRow
        currentBranch={null}
        projectName={null}
        hostBadge={hostBadge}
        prHint={null}
        serviceSummary={null}
      />
    </View>
  );
}

export function HostAppearanceSection({ host }: { host: HostProfile }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { setHostColor, setHostBadgeDisplay } = useHostMutations();
  const localDaemon = useLocalDaemonServerIdState();
  const isLocalHost = localDaemon.status === "resolved" && localDaemon.serverId === host.serverId;
  const badgeDisplay = resolveHostBadgeDisplay({
    appearance: host.appearance,
    isLocalHost,
    localHostResolutionPending: localDaemon.status !== "resolved",
  });

  const handleColorChange = useCallback(
    async (color: HostColor) => {
      try {
        await setHostColor(host.serverId, color);
      } catch {
        toast.error(t("errors.unableToSave"));
      }
    },
    [host.serverId, setHostColor, t, toast],
  );
  const handleBadgeDisplayChange = useCallback(
    async (next: HostBadgeDisplay) => {
      try {
        await setHostBadgeDisplay(host.serverId, next);
      } catch {
        toast.error(t("errors.unableToSave"));
      }
    },
    [host.serverId, setHostBadgeDisplay, t, toast],
  );

  return (
    <SettingsSection title={t("settings.host.appearance.title")}>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.host.appearance.name.label")}</Text>
          </View>
          <View style={styles.nameValue}>
            <Text style={styles.nameText} numberOfLines={1}>
              {host.label}
            </Text>
            <HostRenameButton host={host} />
          </View>
        </View>
        <ColorRow color={host.appearance.color} onChange={handleColorChange} />
        <IconRow serverId={host.serverId} />
        {badgeDisplay === null ? null : (
          <>
            <BadgeDisplayRow badgeDisplay={badgeDisplay} onChange={handleBadgeDisplayChange} />
            <BadgePreview host={host} badgeDisplay={badgeDisplay} />
          </>
        )}
      </View>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  swatch: {
    width: ICON_SIZE.md,
    height: ICON_SIZE.md,
    borderRadius: ICON_SIZE.md / 2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  renameButton: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  nameValue: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 1,
  },
  nameText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    flexShrink: 1,
  },
  preview: {
    flexDirection: "column",
    alignItems: "flex-start",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  previewTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    flexShrink: 1,
  },
}));
