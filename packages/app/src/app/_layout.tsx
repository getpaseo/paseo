import { Stack } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { SessionProvider } from "@/contexts/session-context";
import { RealtimeProvider } from "@/contexts/realtime-context";
import { useSettings } from "@/hooks/use-settings";
import { View, ActivityIndicator } from "react-native";

function ProvidersWrapper({ children }: { children: React.ReactNode }) {
  const { settings, isLoading } = useSettings();

  if (isLoading) {
    return (
      <View
        style={{
          flex: 1,
          justifyContent: "center",
          alignItems: "center",
          backgroundColor: "#09090b",
        }}
      >
        <ActivityIndicator size="large" color="#fafafa" />
      </View>
    );
  }

  return (
    <SessionProvider serverUrl={settings.serverUrl}>
      <RealtimeProvider>{children}</RealtimeProvider>
    </SessionProvider>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <KeyboardProvider>
          <BottomSheetModalProvider>
            <ProvidersWrapper>
              <Stack
                screenOptions={{
                  headerShown: false,
                  animation: "slide_from_right",
                  animationDuration: 250,
                  gestureEnabled: true,
                  gestureDirection: "horizontal",
                  fullScreenGestureEnabled: true,
                  animationMatchesGesture: true,
                }}
              >
                <Stack.Screen name="index" />
                <Stack.Screen name="orchestrator" />
                <Stack.Screen name="agent/[id]" />
                <Stack.Screen name="settings" />
                <Stack.Screen name="audio-test" />
              </Stack>
            </ProvidersWrapper>
          </BottomSheetModalProvider>
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
