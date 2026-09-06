import { useCallback, useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, Pencil } from "lucide-react-native";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import { WorkspaceMetaRow } from "@/components/sidebar/workspace-meta-row";
import { useToast } from "@/contexts/toast-context";
import { SettingsSection } from "@/screens/settings/settings-section";
import {
  HOST_BADGE_DISPLAYS,
  HOST_COLORS,
  resolveHostBadgeDisplay,
  resolveHostColor,
  resolveHostDefaultColor,
  type HostBadgeDisplay,
  type HostColor,
} from "@/hosts/appearance";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useLocalDaemonServerIdState } from "@/hooks/use-is-local-daemon";
import { useHostMutations, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import {
  IDENTITY_COLOR_NAMES,
  deriveIdentityColorName,
  identityColor,
  parseIdentityColorName,
  type IdentityColorName,
} from "@/styles/identity-colors";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import type { HostProfile } from "@/types/host-connection";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedPencil = withUnistyles(Pencil);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function dropdownTriggerStyle({ pressed }: PressableStateCallbackType) {
  return pressed ? [styles.trigger, styles.triggerPressed] : styles.trigger;
}

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

function badgeDisplayLabel(t: TFunction, display: HostBadgeDisplay): string {
  return t(`settings.host.appearance.badge.options.${display}`);
}

function ColorSwatch({ color }: { color: IdentityColorName }) {
  const swatchStyle = useMemo(
    () => [styles.swatch, { backgroundColor: identityColor(color) }],
    [color],
  );
  return <View style={swatchStyle} />;
}

interface ColorOption<V extends string> {
  value: V;
  label: string;
  color: IdentityColorName;
}

function ColorMenuItem<V extends string>({
  option,
  selected,
  onChange,
}: {
  option: ColorOption<V>;
  selected: boolean;
  onChange: (value: V) => void;
}) {
  const handleSelect = useCallback(() => onChange(option.value), [option.value, onChange]);
  const leading = useMemo(() => <ColorSwatch color={option.color} />, [option.color]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect} leading={leading}>
      {option.label}
    </DropdownMenuItem>
  );
}

/**
 * A row whose value is one of a fixed list of swatched options. The first option of either
 * color row is an inherited default, so every option carries the color it resolves to rather
 * than the menu special-casing "none".
 */
function ColorPickerRow<V extends string>({
  title,
  hint,
  accessibilityLabel,
  options,
  value,
  onChange,
  testID,
}: {
  title: string;
  hint?: string;
  accessibilityLabel: string;
  options: readonly ColorOption<V>[];
  value: V;
  onChange: (value: V) => void;
  testID?: string;
}) {
  const selected = options.find((option) => option.value === value) ?? options[0];
  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{title}</Text>
        {hint ? <Text style={settingsStyles.rowHint}>{hint}</Text> : null}
      </View>
      <DropdownMenu>
        <DropdownMenuTrigger
          testID={testID}
          style={dropdownTriggerStyle}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
        >
          <ColorSwatch color={selected.color} />
          <Text style={styles.triggerText}>{selected.label}</Text>
          <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="end" width={200}>
          {options.map((option) => (
            <ColorMenuItem
              key={option.value}
              option={option}
              selected={option.value === value}
              onChange={onChange}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

function ColorRow({ host, onChange }: { host: HostProfile; onChange: (color: HostColor) => void }) {
  const { t } = useTranslation();
  const inherited = resolveHostDefaultColor(host);
  const options = useMemo(
    () =>
      HOST_COLORS.map((color) => ({
        value: color,
        label: colorLabel(t, color),
        color: color === "none" ? inherited : color,
      })),
    [inherited, t],
  );
  return (
    <ColorPickerRow
      title={t("settings.host.appearance.color.label")}
      accessibilityLabel={t("settings.host.appearance.color.accessibilityLabel", {
        value: colorLabel(t, host.appearance.color),
      })}
      options={options}
      value={host.appearance.color}
      onChange={onChange}
    />
  );
}

type HostDefaultColorValue = "auto" | IdentityColorName;

/**
 * The color the host declares for itself, stored in the daemon config so every device that has
 * not picked its own color agrees. Rendered only against a daemon that advertises the setting.
 */
function HostDefaultColorRow({ host }: { host: HostProfile }) {
  const { t } = useTranslation();
  const toast = useToast();
  const isConnected = useHostRuntimeIsConnected(host.serverId);
  const supported = useSessionStore(
    (state) => state.sessions[host.serverId]?.serverInfo?.features?.hostAppearance === true,
  );
  const { config, patchConfig } = useDaemonConfig(supported && isConnected ? host.serverId : null);
  const value: HostDefaultColorValue = parseIdentityColorName(config?.appearance?.color) ?? "auto";
  const options = useMemo(
    () => [
      {
        value: "auto" as const,
        label: t("settings.host.appearance.hostColor.options.auto"),
        color: deriveIdentityColorName(host.serverId),
      },
      ...IDENTITY_COLOR_NAMES.map((color) => ({
        value: color,
        label: colorLabel(t, color),
        color,
      })),
    ],
    [host.serverId, t],
  );
  const handleChange = useCallback(
    async (next: HostDefaultColorValue) => {
      try {
        await patchConfig({ appearance: { color: next === "auto" ? null : next } });
      } catch {
        toast.error(t("errors.unableToSave"));
      }
    },
    [patchConfig, t, toast],
  );

  if (!supported || !isConnected || !config) {
    return null;
  }

  const selectedLabel = options.find((option) => option.value === value)?.label ?? "";
  return (
    <ColorPickerRow
      title={t("settings.host.appearance.hostColor.label")}
      hint={t("settings.host.appearance.hostColor.hint")}
      accessibilityLabel={t("settings.host.appearance.hostColor.accessibilityLabel", {
        value: selectedLabel,
      })}
      options={options}
      value={value}
      onChange={handleChange}
      testID="host-appearance-host-color"
    />
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
        <DropdownMenuTrigger
          testID="host-appearance-badge-display"
          style={dropdownTriggerStyle}
          accessibilityRole="button"
          accessibilityLabel={t("settings.host.appearance.badge.accessibilityLabel", {
            value: selectedLabel,
          })}
        >
          <Text style={styles.triggerText}>{selectedLabel}</Text>
          <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
        </DropdownMenuTrigger>
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
  const hostBadge = useMemo(
    () =>
      badgeDisplay === "hidden"
        ? null
        : {
            serverId: host.serverId,
            label: host.label,
            color: resolveHostColor(host),
            showLabel: badgeDisplay === "name",
          },
    [badgeDisplay, host],
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
        <ColorRow host={host} onChange={handleColorChange} />
        <HostDefaultColorRow host={host} />
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
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  triggerPressed: {
    opacity: 0.85,
  },
  triggerText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
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
