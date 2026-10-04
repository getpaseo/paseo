import { useTranslation } from "react-i18next";
import { SidebarSectionHeader } from "@/components/sidebar/sidebar-section-header";

export function PinnedSectionHeader({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  return (
    <SidebarSectionHeader
      title={t("sidebar.pinned.title")}
      collapsed={collapsed}
      onToggle={onToggle}
      testID="sidebar-pinned-section-header"
    />
  );
}
