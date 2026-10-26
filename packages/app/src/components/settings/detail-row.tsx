import { SettingsRowHeader } from "./row-header";

interface SettingsDetailRowProps {
  label: string;
  /** What the detail is set to, so the row says it without being opened. */
  summary?: string;
  onPress: () => void;
  /** A row that cannot be opened keeps its summary and drops the chevron. */
  disabled?: boolean;
  testID?: string;
}

/**
 * A settings row that opens a detail, such as a sheet, for one setting. The label, a one-line
 * summary of the current value and a chevron pointing right. Sits inside a `SettingsCard`.
 */
export function SettingsDetailRow({
  label,
  summary,
  onPress,
  disabled,
  testID,
}: SettingsDetailRowProps) {
  return (
    <SettingsRowHeader
      label={label}
      summary={summary}
      onPress={onPress}
      disabled={disabled}
      testID={testID}
    />
  );
}
