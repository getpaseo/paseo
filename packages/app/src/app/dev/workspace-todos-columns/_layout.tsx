import { Stack, Unmatched } from "expo-router";
import { ThemedStack } from "@/navigation/themed-stack";

const SCREEN_OPTIONS = { headerShown: false };

export default function ColumnsLayout() {
  if (process.env.NODE_ENV !== "development") return <Unmatched />;
  return (
    <ThemedStack screenOptions={SCREEN_OPTIONS}>
      <Stack.Screen name="index" />
    </ThemedStack>
  );
}
