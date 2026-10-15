import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { TodoDemo } from "./demo";
import TodoAlt1Compact from "./TodoAlt1Compact";
import TodoAlt2Steps from "./TodoAlt2Steps";
import TodoAlt3Board from "./TodoAlt3Board";
import TodoAlt4Detail from "./TodoAlt4Detail";
import TodoAlt5Focus from "./TodoAlt5Focus";
const VARIANTS = [
  {
    value: "original",
    label: "Original",
    description: "Reference layout reproduced with sample data; no daemon connection.",
    component: <TodoDemo layout="original" />,
  },
  {
    value: "compact",
    label: "1 · Compact",
    description: "A quiet checklist: reveal notes only when you need them.",
    component: <TodoAlt1Compact />,
  },
  {
    value: "steps",
    label: "2 · Steps",
    description: "Numbered steps along a vertical rail make project order visible.",
    component: <TodoAlt2Steps />,
  },
  {
    value: "board",
    label: "3 · Board",
    description: "Three columns separate upcoming, active and completed work.",
    component: <TodoAlt3Board />,
  },
  {
    value: "detail",
    label: "4 · Detail",
    description: "A task list beside a reading pane keeps long notes out of the checklist.",
    component: <TodoAlt4Detail />,
  },
  {
    value: "focus",
    label: "5 · Focus",
    description: "The current step leads; the full checklist stays immediately below.",
    component: <TodoAlt5Focus />,
  },
];
export default function Comparison() {
  const [active, setActive] = useState("original");
  const current = VARIANTS.find((variant) => variant.value === active)!;
  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Workspace To-do · Design alternatives</Text>
      <Text style={styles.muted}>
        Development preview · Changes here are never saved to your workspace.
      </Text>
      <ScrollView horizontal>
        <SegmentedControl options={VARIANTS} value={active} onValueChange={setActive} size="sm" />
      </ScrollView>
      <Text style={styles.muted}>{current.description}</Text>
      <View key={active} style={styles.stage}>
        {current.component}
      </View>
      <Text style={styles.muted}>
        Try adding a task, changing its status or opening notes. Each tab starts with the same
        sample checklist.
      </Text>
    </ScrollView>
  );
}
const styles = StyleSheet.create((theme) => ({
  page: { flex: 1, backgroundColor: theme.colors.surface1 },
  content: { padding: theme.spacing[6], gap: theme.spacing[4] },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, lineHeight: 20 },
  stage: { paddingVertical: theme.spacing[4] },
}));
