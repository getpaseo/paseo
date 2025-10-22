import { Stack } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KeyboardProvider } from 'react-native-keyboard-controller';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <KeyboardProvider>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="settings" />
          <Stack.Screen name="audio-test" />
        </Stack>
      </KeyboardProvider>
    </SafeAreaProvider>
  );
}
