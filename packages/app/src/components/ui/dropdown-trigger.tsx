import type { ReactElement, ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown } from "lucide-react-native";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { DropdownMenuTrigger, type DropdownMenuTriggerProps } from "@/components/ui/dropdown-menu";

const ThemedChevronDown = withUnistyles(ChevronDown);

interface DropdownTriggerProps extends Omit<DropdownMenuTriggerProps, "children"> {
  children?: ReactNode;
  chevron?: ReactNode | null;
}

const chevronColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

export function DropdownTrigger({
  children,
  chevron,
  ...props
}: DropdownTriggerProps): ReactElement {
  return (
    <DropdownMenuTrigger {...props}>
      <View style={styles.row}>
        {children}
        {chevron !== null &&
          (chevron ?? (
            <View style={styles.chevronContainer}>
              <ThemedChevronDown size={ICON_SIZE.sm} uniProps={chevronColorMapping} />
            </View>
          ))}
      </View>
    </DropdownMenuTrigger>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  chevronContainer: {
    transform: [{ translateY: 1 }],
  },
}));
