import type { ReactElement } from "react";
import { Text, type StyleProp, type TextStyle } from "react-native";
import { useTimeAgo } from "@/hooks/use-time-ago";

/**
 * A prose relative timestamp ("5m ago") that keeps itself current.
 *
 * Its own component so the clock stops here: `useTimeAgo` holds state, and state re-renders the
 * component that owns it, so a tick never reaches the row it sits in.
 */
export function TimeAgoText({
  date,
  style,
  numberOfLines,
  testID,
}: {
  date: Date;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  testID?: string;
}): ReactElement {
  const label = useTimeAgo(date);
  return (
    <Text style={style} numberOfLines={numberOfLines} testID={testID}>
      {label}
    </Text>
  );
}
