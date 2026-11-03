import type { ReactNode } from "react";
import { SettingsRowHeader } from "./row-header";

interface SettingsDetailRowProps {
  label: string;
  /** Shown beside the label, such as a badge. */
  labelAccessory?: ReactNode;
  /** A line under the label saying what the row leads to. */
  hint?: string;
  /** What the detail is set to, so the row says it without being opened. */
  summary?: string;
  onPress: () => void;
  /** A row that cannot be opened keeps its summary and drops the chevron. */
  disabled?: boolean;
  /** Opens a page outside the app; an outward arrow replaces the chevron. */
  external?: boolean;
  testID?: string;
}

/**
 * A settings row that opens a detail, such as a sheet, for one setting. The label, a one-line
 * summary of the current value and a chevron pointing right. Sits inside a `SettingsCard`.
 */
export function SettingsDetailRow(props: SettingsDetailRowProps) {
  return <SettingsRowHeader {...props} />;
}
