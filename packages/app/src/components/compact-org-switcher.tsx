import { useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Check, ChevronDown, Plus } from "lucide-react-native";
import { router } from "expo-router";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { useOrganizations } from "@/desktop/hooks/use-organizations";
import { setActiveOrgId, useActiveOrgId } from "@/stores/active-org-store";
import { useWorkspaceTabsStore } from "@/stores/workspace-tabs-store";

/**
 * Compact org switcher for the mobile/compact sidebar — the desktop rail
 * (`DesktopOrgRail`) is hidden on compact layouts, leaving mobile users with
 * no way to change organizations. Renders the current org (logo + name) as a
 * pressable row; tapping it opens a sheet listing orgs plus "Create".
 */
export function CompactOrgSwitcher({ onAfterSwitch }: { onAfterSwitch?: () => void }) {
  const { theme } = useUnistyles();
  const { organizations } = useOrganizations();
  const activeOrgId = useActiveOrgId();
  const [open, setOpen] = useState(false);

  if (organizations.length === 0) return null;

  const activeOrg = organizations.find((o) => o.id === activeOrgId) ?? organizations[0] ?? null;
  if (!activeOrg) return null;

  const initial = (activeOrg.name ?? "").trim().charAt(0).toUpperCase() || "?";

  const handleSelect = (orgId: string) => {
    setOpen(false);
    if (orgId === activeOrgId) return;
    useWorkspaceTabsStore.getState().resetAll();
    setActiveOrgId(orgId);
    router.replace("/welcome");
    onAfterSwitch?.();
  };

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Current organization ${activeOrg.name}. Change organization`}
        onPress={() => setOpen(true)}
        style={({ hovered = false }) => [styles.trigger, hovered && styles.triggerHovered]}
      >
        <View style={styles.logoWrap}>
          {activeOrg.logo ? (
            <Image source={{ uri: activeOrg.logo }} style={styles.logoImg} />
          ) : (
            <Text style={styles.logoInitial}>{initial}</Text>
          )}
        </View>
        <Text style={styles.orgName} numberOfLines={1}>
          {activeOrg.name}
        </Text>
        <ChevronDown size={16} color={theme.colors.foregroundMuted} />
      </Pressable>

      <AdaptiveModalSheet visible={open} onClose={() => setOpen(false)} title="Switch organization">
        <View style={styles.list}>
          {organizations.map((o) => {
            const active = o.id === activeOrg.id;
            const rowInitial = (o.name ?? "").trim().charAt(0).toUpperCase() || "?";
            return (
              <Pressable
                key={o.id}
                onPress={() => handleSelect(o.id)}
                style={({ hovered = false }) => [styles.row, hovered && styles.rowHovered]}
                accessibilityRole="button"
                accessibilityLabel={`Select ${o.name}`}
              >
                <View style={styles.rowLogoWrap}>
                  {o.logo ? (
                    <Image source={{ uri: o.logo }} style={styles.rowLogoImg} />
                  ) : (
                    <Text style={styles.rowLogoInitial}>{rowInitial}</Text>
                  )}
                </View>
                <Text style={styles.rowName} numberOfLines={1}>
                  {o.name}
                </Text>
                {active ? <Check size={16} color={theme.colors.accent} /> : null}
              </Pressable>
            );
          })}

          <Pressable
            onPress={() => {
              setOpen(false);
              router.push("/settings?tab=account");
            }}
            style={({ hovered = false }) => [
              styles.row,
              styles.createRow,
              hovered && styles.rowHovered,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Create organization"
          >
            <View style={[styles.rowLogoWrap, styles.createIconWrap]}>
              <Plus size={16} color={theme.colors.foregroundMuted} />
            </View>
            <Text style={[styles.rowName, { color: theme.colors.foregroundMuted }]}>
              Create organization
            </Text>
          </Pressable>
        </View>
      </AdaptiveModalSheet>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  triggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  logoWrap: {
    width: 24,
    height: 24,
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  logoImg: { width: 24, height: 24 },
  logoInitial: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
  },
  orgName: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  list: { gap: theme.spacing[1] },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    minHeight: 48,
  },
  rowHovered: { backgroundColor: theme.colors.surface2 },
  rowLogoWrap: {
    width: 32,
    height: 32,
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  rowLogoImg: { width: 32, height: 32 },
  rowLogoInitial: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  rowName: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  createRow: {
    marginTop: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing[3],
  },
  createIconWrap: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderStyle: "dashed",
    backgroundColor: "transparent",
  },
}));
