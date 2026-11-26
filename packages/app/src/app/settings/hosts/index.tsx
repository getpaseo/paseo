import SettingsScreen from "@/screens/settings-screen";

const HOSTS_VIEW = { kind: "section" as const, section: "hosts" as const };

export default function SettingsHostsSectionRoute() {
  return <SettingsScreen view={HOSTS_VIEW} />;
}
