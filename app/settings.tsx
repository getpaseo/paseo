import { useState, useEffect } from 'react';
import { View, Text, TextInput, Switch, Pressable, ScrollView, Alert, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import {
  AppSettings,
  getSettings,
  saveSettings,
  resetSettings,
  validateServerUrl,
} from '../lib/settings-storage';

export default function SettingsScreen() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [serverUrl, setServerUrl] = useState('');
  const [useSpeaker, setUseSpeaker] = useState(false);
  const [keepScreenOn, setKeepScreenOn] = useState(true);
  const [theme, setTheme] = useState<'dark' | 'light' | 'auto'>('dark');
  const [urlError, setUrlError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  useEffect(() => {
    loadSettings();
  }, []);

  async function loadSettings() {
    const loaded = await getSettings();
    setSettings(loaded);
    setServerUrl(loaded.serverUrl);
    setUseSpeaker(loaded.useSpeaker);
    setKeepScreenOn(loaded.keepScreenOn);
    setTheme(loaded.theme);
  }

  function validateUrl(url: string) {
    const validation = validateServerUrl(url);
    setUrlError(validation.valid ? null : validation.error || null);
    return validation.valid;
  }

  async function handleSaveSettings() {
    if (!validateUrl(serverUrl)) {
      return;
    }

    setIsSaving(true);
    try {
      const newSettings: AppSettings = {
        serverUrl,
        useSpeaker,
        keepScreenOn,
        theme,
      };
      await saveSettings(newSettings);
      setSettings(newSettings);
      Alert.alert('Success', 'Settings saved successfully');
    } catch (error) {
      Alert.alert('Error', 'Failed to save settings');
      console.error('Save settings error:', error);
    } finally {
      setIsSaving(false);
    }
  }

  async function handleResetSettings() {
    Alert.alert(
      'Reset Settings',
      'Are you sure you want to reset all settings to defaults?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: async () => {
            const defaults = await resetSettings();
            setServerUrl(defaults.serverUrl);
            setUseSpeaker(defaults.useSpeaker);
            setKeepScreenOn(defaults.keepScreenOn);
            setTheme(defaults.theme);
            setSettings(defaults);
            Alert.alert('Success', 'Settings reset to defaults');
          },
        },
      ]
    );
  }

  async function handleTestConnection() {
    if (!validateUrl(serverUrl)) {
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

  if (!settings) {
    return (
      <View className="flex-1 bg-black items-center justify-center">
        <ActivityIndicator size="large" color="#3b82f6" />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-black">
      <StatusBar style="light" />

      {/* Header */}
      <View className="pt-14 pb-4 px-6 border-b border-zinc-800">
        <View className="flex-row items-center justify-between">
          <Text className="text-white text-2xl font-bold">Settings</Text>
          <Pressable
            onPress={() => router.back()}
            className="px-4 py-2 rounded-lg bg-zinc-800 active:bg-zinc-700"
          >
            <Text className="text-white font-medium">Done</Text>
          </Pressable>
        </View>
      </View>

      <ScrollView className="flex-1 px-6 py-6">
        {/* Server Configuration */}
        <View className="mb-8">
          <Text className="text-zinc-400 text-sm font-semibold uppercase mb-3">
            Server Configuration
          </Text>

          <View className="bg-zinc-900 rounded-lg p-4 border border-zinc-800">
            <Text className="text-white mb-2 font-medium">WebSocket URL</Text>
            <TextInput
              className="bg-zinc-800 text-white px-4 py-3 rounded-lg border border-zinc-700"
              value={serverUrl}
              onChangeText={(text) => {
                setServerUrl(text);
                validateUrl(text);
                setTestResult(null);
              }}
              placeholder="wss://your-server.com/ws"
              placeholderTextColor="#71717a"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
            {urlError && (
              <Text className="text-red-500 text-sm mt-2">{urlError}</Text>
            )}

            {testResult && (
              <View
                className={`mt-3 p-3 rounded-lg ${
                  testResult.success ? 'bg-green-900/30 border border-green-700' : 'bg-red-900/30 border border-red-700'
                }`}
              >
                <Text className={testResult.success ? 'text-green-400' : 'text-red-400'}>
                  {testResult.message}
                </Text>
              </View>
            )}

            <Pressable
              onPress={handleTestConnection}
              disabled={isTesting || !!urlError}
              className={`mt-3 py-3 rounded-lg flex-row items-center justify-center ${
                isTesting || urlError ? 'bg-zinc-700' : 'bg-blue-600 active:bg-blue-700'
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
          </View>
        </View>

        {/* Audio Settings */}
        <View className="mb-8">
          <Text className="text-zinc-400 text-sm font-semibold uppercase mb-3">
            Audio Settings
          </Text>

          <View className="bg-zinc-900 rounded-lg border border-zinc-800">
            <View className="flex-row items-center justify-between p-4 border-b border-zinc-800">
              <View className="flex-1">
                <Text className="text-white font-medium">Use Speaker</Text>
                <Text className="text-zinc-500 text-sm mt-1">
                  Use phone speaker instead of earpiece
                </Text>
              </View>
              <Switch
                value={useSpeaker}
                onValueChange={setUseSpeaker}
                trackColor={{ false: '#3f3f46', true: '#3b82f6' }}
                thumbColor="#f4f4f5"
              />
            </View>

            <View className="flex-row items-center justify-between p-4">
              <View className="flex-1">
                <Text className="text-white font-medium">Keep Screen On</Text>
                <Text className="text-zinc-500 text-sm mt-1">
                  Prevent screen from sleeping during use
                </Text>
              </View>
              <Switch
                value={keepScreenOn}
                onValueChange={setKeepScreenOn}
                trackColor={{ false: '#3f3f46', true: '#3b82f6' }}
                thumbColor="#f4f4f5"
              />
            </View>
          </View>
        </View>

        {/* App Information */}
        <View className="mb-8">
          <Text className="text-zinc-400 text-sm font-semibold uppercase mb-3">
            App Information
          </Text>

          <View className="bg-zinc-900 rounded-lg p-4 border border-zinc-800">
            <View className="flex-row justify-between mb-3">
              <Text className="text-zinc-400">App Version</Text>
              <Text className="text-white">1.0.0</Text>
            </View>
            <View className="flex-row justify-between mb-3">
              <Text className="text-zinc-400">Audio Format</Text>
              <Text className="text-white">PCM 16kHz Mono</Text>
            </View>
            <View className="flex-row justify-between">
              <Text className="text-zinc-400">Current Server</Text>
              <Text className="text-white text-xs" numberOfLines={1} ellipsizeMode="middle">
                {settings.serverUrl.replace('wss://', '').replace('ws://', '')}
              </Text>
            </View>
          </View>
        </View>

        {/* Actions */}
        <View className="mb-8">
          <Pressable
            onPress={handleSaveSettings}
            disabled={isSaving || !!urlError}
            className={`py-4 rounded-lg mb-3 ${
              isSaving || urlError ? 'bg-zinc-700' : 'bg-blue-600 active:bg-blue-700'
            }`}
          >
            {isSaving ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text className="text-white font-bold text-center text-lg">
                Save Settings
              </Text>
            )}
          </Pressable>

          <Pressable
            onPress={handleResetSettings}
            className="py-4 rounded-lg border border-zinc-700 bg-zinc-900 active:bg-zinc-800"
          >
            <Text className="text-zinc-300 font-semibold text-center">
              Reset to Defaults
            </Text>
          </Pressable>
        </View>

        {/* Bottom spacing */}
        <View className="h-8" />
      </ScrollView>
    </View>
  );
}
