import { useState, useEffect } from 'react';
import { View, Text, ScrollView, TextInput, Switch, Pressable, Alert, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSettings } from '@/hooks/use-settings';

export default function SettingsScreen() {
  const { settings, isLoading, updateSettings, resetSettings } = useSettings();
  const insets = useSafeAreaInsets();

  const [serverUrl, setServerUrl] = useState(settings.serverUrl);
  const [useSpeaker, setUseSpeaker] = useState(settings.useSpeaker);
  const [keepScreenOn, setKeepScreenOn] = useState(settings.keepScreenOn);
  const [theme, setTheme] = useState<'dark' | 'light' | 'auto'>(settings.theme);
  const [hasChanges, setHasChanges] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  // Update local state when settings load
  useEffect(() => {
    setServerUrl(settings.serverUrl);
    setUseSpeaker(settings.useSpeaker);
    setKeepScreenOn(settings.keepScreenOn);
    setTheme(settings.theme);
  }, [settings]);

  // Track changes
  useEffect(() => {
    const changed =
      serverUrl !== settings.serverUrl ||
      useSpeaker !== settings.useSpeaker ||
      keepScreenOn !== settings.keepScreenOn ||
      theme !== settings.theme;
    setHasChanges(changed);
  }, [serverUrl, useSpeaker, keepScreenOn, theme, settings]);

  function validateServerUrl(url: string): boolean {
    try {
      const urlObj = new URL(url);
      return urlObj.protocol === 'ws:' || urlObj.protocol === 'wss:';
    } catch {
      return false;
    }
  }

  async function handleSave() {
    // Validate server URL
    if (!validateServerUrl(serverUrl)) {
      Alert.alert(
        'Invalid URL',
        'Server URL must be a valid WebSocket URL (ws:// or wss://)',
        [{ text: 'OK' }]
      );
      return;
    }

    try {
      await updateSettings({
        serverUrl,
        useSpeaker,
        keepScreenOn,
        theme,
      });

      Alert.alert(
        'Settings Saved',
        'Your settings have been saved successfully.',
        [
          {
            text: 'OK',
            onPress: () => router.back(),
          },
        ]
      );
    } catch (error) {
      Alert.alert(
        'Error',
        'Failed to save settings. Please try again.',
        [{ text: 'OK' }]
      );
    }
  }

  async function handleReset() {
    Alert.alert(
      'Reset Settings',
      'Are you sure you want to reset all settings to defaults?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: async () => {
            try {
              await resetSettings();
              Alert.alert('Settings Reset', 'All settings have been reset to defaults.');
            } catch (error) {
              Alert.alert('Error', 'Failed to reset settings. Please try again.');
            }
          },
        },
      ]
    );
  }

  function handleCancel() {
    if (hasChanges) {
      Alert.alert(
        'Discard Changes',
        'You have unsaved changes. Are you sure you want to go back?',
        [
          { text: 'Stay', style: 'cancel' },
          {
            text: 'Discard',
            style: 'destructive',
            onPress: () => router.back(),
          },
        ]
      );
    } else {
      router.back();
    }
  }

  async function handleTestConnection() {
    if (!validateServerUrl(serverUrl)) {
      Alert.alert(
        'Invalid URL',
        'Server URL must be a valid WebSocket URL (ws:// or wss://)',
        [{ text: 'OK' }]
      );
      return;
    }

    setIsTesting(true);
    setTestResult(null);

    try {
      const ws = new WebSocket(serverUrl);

      const timeout = setTimeout(() => {
        ws.close();
        setTestResult({
          success: false,
          message: 'Connection timeout - server did not respond',
        });
        setIsTesting(false);
      }, 5000);

      ws.onopen = () => {
        clearTimeout(timeout);
        ws.close();
        setTestResult({
          success: true,
          message: 'Connection successful',
        });
        setIsTesting(false);
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        setTestResult({
          success: false,
          message: 'Connection failed - check URL and network',
        });
        setIsTesting(false);
      };
    } catch (error) {
      setTestResult({
        success: false,
        message: 'Failed to create connection',
      });
      setIsTesting(false);
    }
  }

  if (isLoading) {
    return (
      <View className="flex-1 bg-black items-center justify-center">
        <Text className="text-white text-lg">Loading settings...</Text>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-black">
      {/* Header */}
      <View className="px-6 pb-4 border-b border-gray-800" style={{ paddingTop: insets.top + 16 }}>
        <View className="flex-row items-center justify-between">
          <Text className="text-white text-3xl font-bold">Settings</Text>
          <Pressable onPress={handleCancel}>
            <Text className="text-blue-500 text-base font-semibold">Cancel</Text>
          </Pressable>
        </View>
      </View>

      <ScrollView className="flex-1">
        <View className="p-6">
          {/* Server Configuration */}
          <View className="mb-8">
            <Text className="text-white text-lg font-semibold mb-4">
              Server Configuration
            </Text>

            <Text className="text-gray-400 text-sm mb-2">WebSocket URL</Text>
            <TextInput
              className="bg-zinc-900 text-white p-4 rounded-lg mb-2"
              placeholder="wss://example.com/ws"
              placeholderTextColor="#6b7280"
              value={serverUrl}
              onChangeText={(text) => {
                setServerUrl(text);
                setTestResult(null);
              }}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
            <Text className="text-gray-500 text-xs mb-3">
              Must be a valid WebSocket URL (ws:// or wss://)
            </Text>

            {/* Test Connection Button */}
            <Pressable
              onPress={handleTestConnection}
              disabled={isTesting || !validateServerUrl(serverUrl)}
              className={`p-3 rounded-lg mb-3 flex-row items-center justify-center ${
                isTesting || !validateServerUrl(serverUrl) ? 'bg-zinc-800' : 'bg-blue-600 active:bg-blue-700'
              }`}
            >
              {isTesting ? (
                <>
                  <ActivityIndicator size="small" color="#fff" />
                  <Text className="text-white font-semibold ml-2">Testing...</Text>
                </>
              ) : (
                <Text className="text-white font-semibold">Test Connection</Text>
              )}
            </Pressable>

            {/* Test Result */}
            {testResult && (
              <View
                className={`p-3 rounded-lg ${
                  testResult.success
                    ? 'bg-green-900/30 border border-green-700'
                    : 'bg-red-900/30 border border-red-700'
                }`}
              >
                <Text className={testResult.success ? 'text-green-400' : 'text-red-400'}>
                  {testResult.message}
                </Text>
              </View>
            )}
          </View>

          {/* Audio Settings */}
          <View className="mb-8">
            <Text className="text-white text-lg font-semibold mb-4">
              Audio
            </Text>

            <View className="bg-zinc-900 rounded-lg p-4 mb-3">
              <View className="flex-row justify-between items-center">
                <View className="flex-1">
                  <Text className="text-white text-base mb-1">Use Speaker</Text>
                  <Text className="text-gray-400 text-sm">
                    Play audio through speaker instead of earpiece
                  </Text>
                </View>
                <Switch
                  value={useSpeaker}
                  onValueChange={setUseSpeaker}
                  trackColor={{ false: '#374151', true: '#3b82f6' }}
                  thumbColor={useSpeaker ? '#60a5fa' : '#d1d5db'}
                />
              </View>
            </View>

            <View className="bg-zinc-900 rounded-lg p-4">
              <View className="flex-row justify-between items-center">
                <View className="flex-1">
                  <Text className="text-white text-base mb-1">Keep Screen On</Text>
                  <Text className="text-gray-400 text-sm">
                    Prevent screen from sleeping during voice sessions
                  </Text>
                </View>
                <Switch
                  value={keepScreenOn}
                  onValueChange={setKeepScreenOn}
                  trackColor={{ false: '#374151', true: '#3b82f6' }}
                  thumbColor={keepScreenOn ? '#60a5fa' : '#d1d5db'}
                />
              </View>
            </View>
          </View>

          {/* Theme Settings */}
          <View className="mb-8">
            <Text className="text-white text-lg font-semibold mb-4">
              Theme
            </Text>

            <View className="bg-zinc-900 rounded-lg p-4 opacity-50">
              <Text className="text-gray-400 text-sm mb-3">
                Theme selection (coming soon)
              </Text>

              {(['dark', 'light', 'auto'] as const).map((themeOption) => (
                <Pressable
                  key={themeOption}
                  disabled
                  className="flex-row items-center py-2"
                >
                  <View className={`w-5 h-5 rounded-full border-2 ${
                    theme === themeOption ? 'border-blue-500' : 'border-gray-600'
                  } mr-3 items-center justify-center`}>
                    {theme === themeOption && (
                      <View className="w-3 h-3 rounded-full bg-blue-500" />
                    )}
                  </View>
                  <Text className="text-gray-400 text-base capitalize">
                    {themeOption}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          {/* Action Buttons */}
          <View className="mb-8">
            <Pressable
              className={`p-4 rounded-lg mb-3 ${
                hasChanges ? 'bg-blue-500' : 'bg-blue-500/50'
              }`}
              onPress={handleSave}
              disabled={!hasChanges}
            >
              <Text className="text-white text-center text-base font-semibold">
                Save Settings
              </Text>
            </Pressable>

            <Pressable
              className="p-4 rounded-lg border border-red-500/30"
              onPress={handleReset}
            >
              <Text className="text-red-500 text-center text-base font-semibold">
                Reset to Defaults
              </Text>
            </Pressable>
          </View>

          {/* App Info */}
          <View className="border-t border-gray-800 pt-6">
            <Text className="text-gray-500 text-sm text-center">
              Voice Assistant Mobile
            </Text>
            <Text className="text-gray-600 text-xs text-center mt-1">
              Version 1.0.0
            </Text>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}
