import { ChevronRight } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";

// Shared chevron used by collapsible git rows (changed-files tree, commits
// section). Kept in one place so the muted-foreground tint and the
// withUnistyles wrapping stay consistent across every disclosure control.
export const ThemedChevron = withUnistyles(ChevronRight);

export const chevronColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
