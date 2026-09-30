import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { usageCopy } from "./copy";
import type { UsageDisplay } from "./display";
import type { UsageDisplayAs } from "./preferences";

const OPTIONS: SegmentedControlOption<UsageDisplayAs>[] = [
  { value: "used", label: usageCopy.displayUsed, testID: "usage-display-used" },
  { value: "remaining", label: usageCopy.displayRemaining, testID: "usage-display-remaining" },
];

/** Switches every usage surface between the share used and the share left. */
export function UsageDisplayToggle({ display }: { display: UsageDisplay }) {
  return (
    <SegmentedControl
      size="xs"
      options={OPTIONS}
      value={display.displayAs}
      onValueChange={display.setDisplayAs}
      testID="usage-display-toggle"
    />
  );
}
