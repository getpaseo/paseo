import type { ComponentType } from "react";
import {
  Settings,
  Palette,
  PanelLeft,
  MessageSquare,
  SquareTerminal,
  Globe,
  Code2,
  Keyboard,
  Puzzle,
  Bell,
  Shield,
  Stethoscope,
  Info,
  Server,
  FolderGit2,
  Network,
  Smartphone,
  Bot,
  Sparkles,
  Boxes,
  Gauge,
  Blocks,
} from "lucide-react-native";
import { AppearanceSection } from "@/screens/settings/appearance/appearance-section";
import { SidebarNavSection } from "@/screens/settings/sidebar/sidebar-nav-section";
import { ChatSection } from "@/screens/settings/chat/chat-section";
import { TerminalSection } from "@/screens/settings/terminal/terminal-section";
import { BrowserDataSection } from "@/desktop/browser/settings/browser-data-section";
import { EditorSection } from "@/screens/settings/editor-section";
import { KeyboardShortcutsSection } from "@/screens/settings/keyboard-shortcuts-section";
import { IntegrationsSection } from "@/desktop/components/integrations-section";
import { DesktopNotificationsSection } from "@/desktop/components/desktop-notifications-section";
import { DesktopPermissionsSection } from "@/desktop/components/desktop-permissions-section";
import { isWeb } from "@/constants/platform";
import type { HostSectionSlug, SettingsSectionSlug } from "@/utils/host-routes";

export interface SidebarSectionItem {
  id: SettingsSectionSlug;
  labelKey: string;
  icon: ComponentType<{ size: number; color: string; strokeWidth?: number }>;
  desktopOnly?: boolean;
  webOnly?: boolean;
  /** The page body, for pages that need nothing from the settings screen. */
  Content?: ComponentType;
}

export const SIDEBAR_SECTION_ITEMS: SidebarSectionItem[] = [
  { id: "general", labelKey: "settings.sections.general", icon: Settings },
  {
    id: "appearance",
    labelKey: "settings.sections.appearance",
    icon: Palette,
    Content: AppearanceSection,
  },
  {
    id: "sidebar",
    labelKey: "settings.sections.sidebar",
    icon: PanelLeft,
    Content: SidebarNavSection,
  },
  { id: "chat", labelKey: "settings.sections.chat", icon: MessageSquare, Content: ChatSection },
  {
    id: "terminal",
    labelKey: "settings.sections.terminal",
    icon: SquareTerminal,
    Content: TerminalSection,
  },
  {
    id: "browser",
    labelKey: "settings.sections.browser",
    icon: Globe,
    desktopOnly: true,
    Content: BrowserDataSection,
  },
  {
    id: "editor",
    labelKey: "settings.sections.editor",
    icon: Code2,
    webOnly: true,
    Content: EditorSection,
  },
  {
    id: "shortcuts",
    labelKey: "settings.sections.shortcuts",
    icon: Keyboard,
    desktopOnly: true,
    Content: KeyboardShortcutsSection,
  },
  {
    id: "integrations",
    labelKey: "settings.sections.integrations",
    icon: Puzzle,
    desktopOnly: true,
    Content: IntegrationsSection,
  },
  {
    id: "notifications",
    labelKey: "settings.sections.notifications",
    icon: Bell,
    desktopOnly: true,
    Content: DesktopNotificationsSection,
  },
  {
    id: "permissions",
    labelKey: "settings.sections.permissions",
    icon: Shield,
    desktopOnly: true,
    Content: DesktopPermissionsSection,
  },
  { id: "diagnostics", labelKey: "settings.sections.diagnostics", icon: Stethoscope },
  { id: "about", labelKey: "settings.sections.about", icon: Info },
];

export function isSectionAvailable(item: SidebarSectionItem, isDesktopApp: boolean): boolean {
  return (!item.desktopOnly || isDesktopApp) && (!item.webOnly || isWeb);
}

export interface HostSectionItem {
  id: HostSectionSlug;
  labelKey: string;
  icon: ComponentType<{ size: number; color: string; strokeWidth?: number }>;
}

export const HOST_SECTION_ITEMS: HostSectionItem[] = [
  { id: "host", labelKey: "settings.hostSections.host", icon: Server },
  { id: "projects", labelKey: "settings.hostSections.projects", icon: FolderGit2 },
  { id: "connections", labelKey: "settings.hostSections.connections", icon: Network },
  { id: "pair-device", labelKey: "openProject.tiles.pairDevice.title", icon: Smartphone },
  { id: "agents", labelKey: "settings.hostSections.agents", icon: Bot },
  { id: "metadata", labelKey: "settings.hostSections.metadata", icon: Sparkles },
  { id: "workspaces", labelKey: "settings.hostSections.workspaces", icon: FolderGit2 },
  { id: "providers", labelKey: "settings.hostSections.providers", icon: Boxes },
  { id: "usage", labelKey: "settings.hostSections.usage", icon: Gauge },
  { id: "terminals", labelKey: "settings.hostSections.terminals", icon: SquareTerminal },
  { id: "plugins", labelKey: "settings.hostSections.plugins", icon: Blocks },
];
