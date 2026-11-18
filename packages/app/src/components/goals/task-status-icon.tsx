import type { ReactElement } from "react";
import { Ban, CheckCircle2, Circle, CircleDot, XCircle } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import type { TaskStatus } from "@getpaseo/protocol/goal/types";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const ThemedCircle = withUnistyles(Circle);
const ThemedCircleDot = withUnistyles(CircleDot);
const ThemedCheck = withUnistyles(CheckCircle2);
const ThemedX = withUnistyles(XCircle);
const ThemedBan = withUnistyles(Ban);

const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const warningColor = (theme: Theme) => ({ color: theme.colors.statusWarning });
const successColor = (theme: Theme) => ({ color: theme.colors.statusSuccess });
const dangerColor = (theme: Theme) => ({ color: theme.colors.statusDanger });

export function TaskStatusIcon({ status }: { status: TaskStatus }): ReactElement {
  const size = ICON_SIZE.md;
  switch (status) {
    case "pending":
      return <ThemedCircle size={size} uniProps={mutedColor} />;
    case "running":
      return <ThemedCircleDot size={size} uniProps={warningColor} />;
    case "succeeded":
      return <ThemedCheck size={size} uniProps={successColor} />;
    case "failed":
      return <ThemedX size={size} uniProps={dangerColor} />;
    case "cancelled":
      return <ThemedBan size={size} uniProps={mutedColor} />;
  }
}
