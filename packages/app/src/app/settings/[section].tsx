import { useLocalSearchParams } from "expo-router";
import SettingsScreen from "@/screens/settings-screen";
import { isSettingsSectionSlug, type SettingsSectionSlug } from "@/utils/host-routes";

export default function SettingsSectionRoute() {
  const params = useLocalSearchParams<{ section?: string }>();
  const rawSection = typeof params.section === "string" ? params.section : "";
  const section: SettingsSectionSlug = isSettingsSectionSlug(rawSection) ? rawSection : "general";

  return <SettingsScreen view={{ kind: "section", section }} />;
}
