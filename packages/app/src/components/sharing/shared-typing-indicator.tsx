import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSharedSessionStore } from "@/stores/shared-session-store";
import { useTypingUsers } from "@/stores/shared-typing-store";
import { userColor } from "@/utils/user-color";

// Blinking caret + member name label, shown above the composer when a remote
// participant is typing. Looks like the input's own text cursor so it's
// immediately recognizable as "someone is writing here".
export function SharedTypingIndicator() {
  const { room, currentUser } = useSharedSessionStore();
  const typing = useTypingUsers();
  const [blinkOn, setBlinkOn] = useState(true);

  useEffect(() => {
    const t = setInterval(() => setBlinkOn((b) => !b), 500);
    return () => clearInterval(t);
  }, []);

  if (!room) return null;
  const others = typing.filter((u) => !currentUser || u.userId !== currentUser.userId);
  if (others.length === 0) return null;

  return (
    <View style={styles.row} pointerEvents="none">
      {others.map((u) => {
        const color = userColor(u.userId);
        return (
          <View key={u.userId} style={styles.chip}>
            <View
              style={[
                styles.caret,
                { backgroundColor: color, opacity: blinkOn ? 1 : 0.15 },
              ]}
            />
            <View style={[styles.nameTag, { backgroundColor: color }]}>
              <Text style={styles.nameText} numberOfLines={1}>
                {u.username || "member"}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingBottom: 4,
    gap: 6,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  caret: {
    width: 2,
    height: 14,
    borderRadius: 1,
  },
  nameTag: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
  },
  nameText: {
    color: "white",
    fontSize: 10,
    fontWeight: "600",
  },
});
