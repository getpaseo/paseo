// SettingsLayout — sidebar + content shell shared by /settings (the SettingsScreen
// state-driven view) and detail routes like /settings/projects/[projectKey] that
// would otherwise lose the sidebar. The detail-route sidebar uses URL navigation
// (router.replace?tab=…) instead of in-memory section state.

import type { ComponentType, ReactNode } from "react";
import { useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  Blocks,
  FolderTree,
  Info,
  Keyboard,
  Network,
  Plug,
  Puzzle,
  Server,
  Settings,
  Shield,
  Smartphone,
  Sparkles,
  Stethoscope,
  Terminal,
  Zap,
} from "lucide-react-native";
import { getIsElectron } from "@/constants/platform";
import { buildSettingsRoute } from "@/utils/host-routes";

export type SettingsLayoutSectionId =
  | "account"
  | "hosts"
  | "projects"
  | "general"
  | "plan"
  | "shortcuts"
  | "integrations"
  | "task-integrations"
  | "providers"
  | "cli-agents"
  | "indexing"
  | "hooks"
  | "commands"
  | "rules"
  | "diagnostics"
  | "about"
  | "permissions"
  | "daemon"
  | "pair-device";

interface SectionDef {
  id: SettingsLayoutSectionId;
  label: string;
  icon: ComponentType<{ size: number; color: string }>;
}

function buildSections(isDesktopApp: boolean): SectionDef[] {
  const sections: SectionDef[] = [
    { id: "account", label: "Account", icon: Shield },
    { id: "hosts", label: "Hosts", icon: Server },
    { id: "projects", label: "Projects", icon: FolderTree },
    { id: "general", label: "General", icon: Settings },
    { id: "task-integrations", label: "Task Integrations", icon: Plug },
    { id: "permissions", label: "Permissions", icon: Shield },
    { id: "plan", label: "Plan", icon: Zap },
  ];

  if (isDesktopApp) {
    sections.push(
      { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
      { id: "integrations", label: "Integrations", icon: Puzzle },
      { id: "pair-device", label: "Pair device", icon: Smartphone },
      { id: "daemon", label: "Daemon", icon: Settings },
      { id: "providers", label: "Providers", icon: Blocks },
      { id: "cli-agents", label: "CLI Agents", icon: Terminal },
      { id: "indexing", label: "Code Indexing", icon: Network },
      { id: "hooks", label: "Hooks", icon: Sparkles },
      { id: "commands", label: "Commands", icon: Terminal },
      { id: "rules", label: "Rules", icon: Info },
    );
  }

  sections.push(
    { id: "diagnostics", label: "Diagnostics", icon: Stethoscope },
    { id: "about", label: "About", icon: Info },
  );

  return sections;
}

interface SettingsLayoutProps {
  selectedSectionId: SettingsLayoutSectionId;
  children: ReactNode;
}

export function SettingsLayout({ selectedSectionId, children }: SettingsLayoutProps) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const sections = useMemo(() => buildSections(getIsElectron()), []);

  const handleSelect = (id: SettingsLayoutSectionId) => {
    router.replace(`${buildSettingsRoute()}?tab=${id}` as never);
  };

  return (
    <View style={styles.row}>
      <View style={styles.sidebar}>
        <ScrollView
          style={styles.sidebarScroll}
          contentContainerStyle={styles.sidebarContent}
          showsVerticalScrollIndicator={false}
        >
          {sections.map((section) => {
            const isSelected = section.id === selectedSectionId;
            const IconComponent = section.icon;
            const showSeparator =
              section.id === "account" ||
              section.id === "integrations" ||
              section.id === "providers";
            return (
              <View key={section.id}>
                {showSeparator ? <View style={styles.sidebarSeparator} /> : null}
                <Pressable
                  style={[
                    styles.sidebarItem,
                    isSelected && { backgroundColor: theme.colors.surface2 },
                  ]}
                  onPress={() => handleSelect(section.id)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isSelected }}
                >
                  <IconComponent
                    size={theme.iconSize.md}
                    color={isSelected ? theme.colors.foreground : theme.colors.foregroundMuted}
                  />
                  <Text
                    style={[styles.sidebarLabel, isSelected && { color: theme.colors.foreground }]}
                    numberOfLines={1}
                  >
                    {section.label}
                  </Text>
                </Pressable>
              </View>
            );
          })}
        </ScrollView>
      </View>
      <ScrollView
        style={styles.contentPane}
        contentContainerStyle={{ paddingBottom: insets.bottom }}
      >
        {children}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flex: 1,
    flexDirection: "row",
    backgroundColor: theme.colors.surface0,
  },
  sidebar: {
    width: 220,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  sidebarScroll: {
    flex: 1,
  },
  sidebarContent: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[2],
  },
  sidebarItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  sidebarSeparator: {
    height: 1,
    backgroundColor: theme.colors.border,
    marginVertical: theme.spacing[2],
    marginHorizontal: theme.spacing[2],
  },
  sidebarLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  contentPane: {
    flex: 1,
  },
}));
