import { usePathname } from "expo-router";
import { History } from "lucide-react-native";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";

interface SidebarHistoryNavigationRowProps {
  onPress: () => void;
}

export function SidebarHistoryNavigationRow({ onPress }: SidebarHistoryNavigationRowProps) {
  const pathname = usePathname();
  const isSessionsActive = pathname.includes("/sessions");

  return (
    <SidebarHeaderRow
      icon={History}
      label="History"
      onPress={onPress}
      isActive={isSessionsActive}
      testID="sidebar-history"
    />
  );
}
