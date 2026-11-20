import { ChevronRight } from "lucide-react-native";
import { useCallback, useMemo, type ReactNode } from "react";
import { Image, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { foregroundIconColorMapping, mutedIconColorMapping } from "@/components/ui/icon-color";
import { PressHighlight } from "@/components/ui/press-highlight";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE } from "@/styles/theme";

const ThemedChevron = withUnistyles(ChevronRight);
type HoverState = PressableStateCallbackType & { hovered?: boolean };

/** A plugin's icon, or its initial on a neutral tile when it has none. */
export function PluginTile({
  name,
  icon,
  size = "md",
}: {
  name: string;
  icon?: string;
  size?: "md" | "lg";
}) {
  const tileStyle = useMemo(() => [styles.tile, size === "lg" && styles.tileLarge], [size]);
  const source = useMemo(() => (icon ? { uri: icon } : null), [icon]);
  if (source) return <Image source={source} style={tileStyle} accessibilityIgnoresInvertColors />;
  return (
    <View style={tileStyle}>
      <Text style={size === "lg" ? styles.initialLarge : styles.initial}>
        {name.slice(0, 1).toUpperCase()}
      </Text>
    </View>
  );
}

/** A listing author's GitHub picture, before their name in a meta line. */
export function AuthorAvatar({ url }: { url: string }) {
  const source = useMemo(() => ({ uri: url }), [url]);
  return <Image source={source} style={styles.avatar} accessibilityIgnoresInvertColors />;
}

/** A line of facts, led by the author's picture when the plugin is listed. */
export function PluginMeta({
  text,
  authorAvatar,
  testID,
}: {
  text: string;
  authorAvatar?: string;
  testID?: string;
}) {
  return (
    <View style={styles.metaRow} testID={testID}>
      {authorAvatar ? <AuthorAvatar url={authorAvatar} /> : null}
      <Text style={styles.metaText} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

export interface PluginRowProps {
  name: string;
  icon?: string;
  /** Beside the name, such as a Failed badge. */
  badge?: ReactNode;
  description?: string;
  /** Who made it and which version, or how many installs. */
  meta?: string;
  /** The listing author's picture, before the meta line. */
  authorAvatar?: string;
  /** Replaces the meta line: what went wrong, in the row the user is looking at. */
  error?: string;
  /** The row's control: a switch, or the install or update button. The chevron follows it. */
  children?: ReactNode;
  onPress(): void;
  accessibilityLabel: string;
  testID?: string;
}

/**
 * One plugin in a card: icon, name, a line of description and a line of facts. The whole row opens
 * the plugin's page; the control in the trailing slot acts without opening it.
 */
export function PluginRow({
  name,
  icon,
  badge,
  description,
  meta,
  authorAvatar,
  error,
  children,
  onPress,
  accessibilityLabel,
  testID,
}: PluginRowProps) {
  const rowStyle = useCallback(
    ({ hovered }: HoverState) => [settingsStyles.row, styles.row, hovered && styles.hovered],
    [],
  );
  return (
    <PressHighlight
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={rowStyle}
      highlightStyle={styles.pressed}
      testID={testID}
    >
      {({ hovered }: HoverState) => (
        <>
          <PluginTile name={name} icon={icon} />
          <View style={styles.text}>
            <View style={styles.titleRow}>
              <Text style={styles.title} numberOfLines={1}>
                {name}
              </Text>
              {badge}
            </View>
            {description ? (
              <Text style={styles.description} numberOfLines={1}>
                {description}
              </Text>
            ) : null}
            {error ? (
              <Text accessibilityRole="alert" style={styles.error} numberOfLines={2}>
                {error}
              </Text>
            ) : null}
            {meta && !error ? (
              <View style={styles.meta}>
                <PluginMeta text={meta} authorAvatar={authorAvatar} />
              </View>
            ) : null}
          </View>
          {children}
          <View style={styles.chevron}>
            <ThemedChevron
              size={ICON_SIZE.sm}
              uniProps={hovered ? foregroundIconColorMapping : mutedIconColorMapping}
            />
          </View>
        </>
      )}
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: { gap: theme.spacing[3] },
  hovered: { backgroundColor: theme.colors.surface2 },
  pressed: { backgroundColor: theme.colors.surface3 },
  tile: {
    width: theme.spacing[8],
    height: theme.spacing[8],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  tileLarge: {
    width: theme.spacing[12],
    height: theme.spacing[12],
    borderRadius: theme.borderRadius.xl,
  },
  initial: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  initialLarge: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xl },
  text: { flex: 1, minWidth: 0 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  title: { flexShrink: 1, color: theme.colors.foreground, fontSize: theme.fontSize.base },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[0.5],
  },
  meta: { marginTop: theme.spacing[0.5] },
  metaRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1.5] },
  metaText: {
    flexShrink: 1,
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
  avatar: {
    width: theme.iconSize.sm,
    height: theme.iconSize.sm,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[0.5],
  },
  // Optical: the chevron's ink sits about 4px inside its box; this puts it on the card's trailing
  // rail, the same as SettingsRowHeader.
  chevron: { marginRight: -theme.spacing[1] },
}));
