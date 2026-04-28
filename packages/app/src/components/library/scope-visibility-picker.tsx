import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Building2, FolderGit2, User, Eye, Lock } from "lucide-react-native";
import type { LibraryScope, LibraryVisibility } from "@/api/library";

interface ScopeVisibilityPickerProps {
  scope: LibraryScope;
  scopeId: string | null;
  visibility: LibraryVisibility;
  onChange: (
    value: Partial<{
      scope: LibraryScope;
      scopeId: string | null;
      visibility: LibraryVisibility;
    }>,
  ) => void;
  /** Currently active org id, used to pre-fill when user picks Org scope. */
  activeOrgId: string | null;
  /** Currently focused workspace/project id, used for Project scope. */
  activeProjectId: string | null;
}

/**
 * Two-axis selector: Scope (where the entry applies) + Visibility (who
 * else sees it). User-scope entries are always private — the visibility
 * row disables itself when that's selected.
 */
export function ScopeVisibilityPicker({
  scope,
  visibility,
  onChange,
  activeOrgId,
  activeProjectId,
}: ScopeVisibilityPickerProps) {
  const setScope = (next: LibraryScope) => {
    if (next === "user") {
      onChange({ scope: "user", scopeId: null, visibility: "private" });
    } else if (next === "org") {
      onChange({ scope: "org", scopeId: activeOrgId });
    } else {
      onChange({ scope: "project", scopeId: activeProjectId });
    }
  };
  const visibilityLocked = scope === "user";
  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>Scope</Text>
      <View style={styles.row}>
        <ScopeChip
          label="Global"
          icon={<User size={14} color="currentColor" />}
          hint="Only me, all my projects"
          active={scope === "user"}
          onPress={() => setScope("user")}
        />
        <ScopeChip
          label="Org"
          icon={<Building2 size={14} color="currentColor" />}
          hint={activeOrgId ? "Current org" : "Requires active org"}
          active={scope === "org"}
          disabled={!activeOrgId}
          onPress={() => setScope("org")}
        />
        <ScopeChip
          label="Project"
          icon={<FolderGit2 size={14} color="currentColor" />}
          hint={activeProjectId ? "Current project" : "Requires active project"}
          active={scope === "project"}
          disabled={!activeProjectId}
          onPress={() => setScope("project")}
        />
      </View>

      <View style={styles.visibilityWrap}>
        <Text style={styles.label}>Visibility</Text>
        <View style={styles.row}>
          <VisChip
            label="Private"
            icon={<Lock size={14} color="currentColor" />}
            hint="Only you"
            active={visibility === "private"}
            onPress={() => onChange({ visibility: "private" })}
          />
          <VisChip
            label="Shared"
            icon={<Eye size={14} color="currentColor" />}
            hint="Recommend to members"
            active={visibility === "shared"}
            disabled={visibilityLocked}
            onPress={() => onChange({ visibility: "shared" })}
          />
        </View>
        {visibilityLocked ? (
          <Text style={styles.lockedHint}>Global entries are always private.</Text>
        ) : null}
      </View>
    </View>
  );
}

interface ChipProps {
  label: string;
  icon: React.ReactNode;
  hint: string;
  active: boolean;
  disabled?: boolean;
  onPress: () => void;
}

function ScopeChip({ label, icon, hint, active, disabled, onPress }: ChipProps) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      style={({ hovered, pressed }) => [
        styles.chip,
        active && styles.chipActive,
        disabled && styles.chipDisabled,
        !disabled && hovered && styles.chipHovered,
        !disabled && pressed && styles.chipPressed,
      ]}
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled: !!disabled }}
    >
      <View style={styles.chipHeader}>
        {icon}
        <Text style={[styles.chipLabel, active && styles.chipLabelActive]}>{label}</Text>
      </View>
      <Text style={styles.chipHint} numberOfLines={1}>
        {hint}
      </Text>
    </Pressable>
  );
}

const VisChip = ScopeChip;

const styles = StyleSheet.create((theme) => ({
  wrap: {
    gap: theme.spacing[2],
  },
  label: {
    fontSize: theme.fontSize.xs,
    fontWeight: "600" as const,
    color: theme.colors.foreground,
    marginBottom: 2,
  },
  row: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  visibilityWrap: {
    marginTop: theme.spacing[3],
    gap: theme.spacing[2],
  },
  chip: {
    flex: 1,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    gap: 2,
    color: theme.colors.foregroundMuted,
  },
  chipHovered: {
    backgroundColor: theme.colors.surface2,
  },
  chipPressed: {
    backgroundColor: theme.colors.surface3,
  },
  chipActive: {
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.surface2,
    color: theme.colors.accent,
  },
  chipDisabled: {
    opacity: 0.5,
  },
  chipHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  chipLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: "500" as const,
    color: theme.colors.foreground,
  },
  chipLabelActive: {
    color: theme.colors.accent,
    fontWeight: "600" as const,
  },
  chipHint: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  lockedHint: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    marginTop: 2,
  },
}));
