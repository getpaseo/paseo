import { Fragment } from "react";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";

/**
 * The secondary datapoints under a usage meter, separated by " · ": reset countdown, exact reset
 * time, quota forecast. They are one line of equal text that wraps at the separators when narrow.
 */
export function UsageDatapointLine({
  datapoints,
  testID,
}: {
  datapoints: readonly (string | null)[];
  testID?: string;
}) {
  const shown = datapoints.filter((datapoint): datapoint is string => Boolean(datapoint));
  if (shown.length === 0) return null;
  return (
    <Text style={styles.line} testID={testID}>
      {shown.map((datapoint, index) => (
        // Datapoints are distinct strings, so the text is a stable key.
        <Fragment key={datapoint}>
          {/* The no-break space keeps the dot on the line of the datapoint before it. */}
          {index > 0 ? "\u00a0· " : null}
          <Text>{datapoint}</Text>
        </Fragment>
      ))}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  line: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
}));
