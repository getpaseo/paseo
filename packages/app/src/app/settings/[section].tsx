import { useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import SettingsScreen from "@/screens/settings-screen";
import { isSettingsSectionSlug, type SettingsSectionSlug } from "@/utils/host-routes";

export default function SettingsSectionRoute() {
  const params = useLocalSearchParams<{ section?: string; addHost?: string }>();
  const rawSection = typeof params.section === "string" ? params.section : "";
  const section: SettingsSectionSlug = isSettingsSectionSlug(rawSection) ? rawSection : "general";
  const openAddHostIntent = typeof params.addHost === "string" ? params.addHost : null;
  const view = useMemo(() => ({ kind: "section" as const, section }), [section]);

  return <SettingsScreen view={view} openAddHostIntent={openAddHostIntent} />;
}
