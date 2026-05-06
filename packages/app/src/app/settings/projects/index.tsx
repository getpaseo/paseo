import SettingsScreen from "@/screens/settings-screen";

const PROJECTS_VIEW = { kind: "projects" as const };

export default function SettingsProjectsIndexRoute() {
  return <SettingsScreen view={PROJECTS_VIEW} />;
}
