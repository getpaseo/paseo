import { View } from "react-native";
import {
  SettingsCard,
  SettingsCollapsibleRow,
  SettingsRow,
  SettingsSwitch,
} from "@/components/settings";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { settingsStyles } from "@/styles/settings";
import { usageCopy } from "./copy";
import type { UsageDisplay } from "./display";
import { useUsageInSidebar } from "./in-sidebar";
import type { UsageDisplayAs } from "./preferences";

const DISPLAY_AS_OPTIONS: SegmentedControlOption<UsageDisplayAs>[] = [
  { value: "used", label: usageCopy.displayUsed, testID: "usage-display-used" },
  { value: "remaining", label: usageCopy.displayRemaining, testID: "usage-display-remaining" },
];

/**
 * The usage options, folded above the reports: whether the sidebar shows the summary (the same
 * switch as Settings > Sidebar) and whether percents read as used or remaining.
 */
export function UsageOptions({ display }: { display: UsageDisplay }) {
  const { inSidebar, setInSidebar } = useUsageInSidebar();
  return (
    <View style={settingsStyles.section}>
      <SettingsCard>
        <SettingsCollapsibleRow label={usageCopy.options} testID="usage-options">
          <SettingsSwitch
            label={usageCopy.showInSidebar}
            hint={usageCopy.showInSidebarHint}
            value={inSidebar}
            onValueChange={setInSidebar}
            testID="usage-show-in-sidebar"
          />
          <SettingsRow label={usageCopy.displayAs}>
            <SegmentedControl
              options={DISPLAY_AS_OPTIONS}
              value={display.displayAs}
              onValueChange={display.setDisplayAs}
              size="sm"
              testID="usage-display-as"
            />
          </SettingsRow>
        </SettingsCollapsibleRow>
      </SettingsCard>
    </View>
  );
}
