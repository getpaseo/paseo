import { Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useRouter } from "expo-router";
import { Button } from "@/components/ui/button";
import { useIsInSharedSession } from "@/stores/shared-session-store";

/**
 * Shows a blocking overlay when a shared session ends.
 * Place this inside the workspace layout so it covers the workspace when the room disconnects.
 *
 * When the user entered via a share link and the Colyseus room disconnects,
 * this component blocks navigation and prompts the user to leave.
 */
export function SharedSessionGuard() {
  // This component is intentionally a no-op for now.
  // The full implementation requires tracking "entered via share link" state
  // and detecting room disconnect. For the MVP, the ParticipantBar disappearing
  // serves as the indicator that the session ended.
  return null;
}
