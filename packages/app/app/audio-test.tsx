import { View, Text, Pressable, ScrollView, Alert } from 'react-native';
import { useState, useEffect } from 'react';
import { useAudioRecorder } from '../hooks/use-audio-recorder';
import { useAudioPlayer } from '../hooks/use-audio-player';
import { getRecordingPermissionsAsync, requestRecordingPermissionsAsync } from 'expo-audio';

export default function AudioTestScreen() {
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [recordingStatus, setRecordingStatus] = useState<'idle' | 'recording' | 'processing'>('idle');
  const [lastRecordingSize, setLastRecordingSize] = useState<number | null>(null);
  const [playbackStatus, setPlaybackStatus] = useState<string>('No audio playing');
  const [lastRecordedBlob, setLastRecordedBlob] = useState<Blob | null>(null);

  const audioRecorder = useAudioRecorder({
    sampleRate: 16000,
    numberOfChannels: 1,
  });

  const audioPlayer = useAudioPlayer();

  useEffect(() => {
    checkAndRequestPermissions();
  }, []);

  async function checkAndRequestPermissions() {
    try {
      const { status } = await getRecordingPermissionsAsync();

      if (status === 'granted') {
        setPermissionGranted(true);
      } else {
        const { granted } = await requestRecordingPermissionsAsync();
        setPermissionGranted(granted);

        if (!granted) {
          Alert.alert(
            'Permission Required',
            'Microphone permission is required to test audio recording.'
          );
        }
      }
    } catch (error) {
      console.error('[AudioTest] Permission error:', error);
      Alert.alert('Error', 'Failed to check/request microphone permissions');
    }
  }

  async function handleStartRecording() {
    if (!permissionGranted) {
      Alert.alert('Permission Required', 'Please grant microphone permission first');
      return;
    }

    try {
      setRecordingStatus('recording');
      setLastRecordingSize(null);
      await audioRecorder.start();
    } catch (error: any) {
      console.error('[AudioTest] Start recording error:', error);
      Alert.alert('Recording Error', error.message);
      setRecordingStatus('idle');
    }
  }

  async function handleStopRecording() {
    try {
      setRecordingStatus('processing');
      const audioBlob = await audioRecorder.stop();

      setLastRecordingSize(audioBlob.size);
      setLastRecordedBlob(audioBlob);
      setRecordingStatus('idle');

      Alert.alert(
        'Recording Complete',
        `Audio recorded successfully!\nSize: ${audioBlob.size} bytes\nType: ${audioBlob.type}`
      );
    } catch (error: any) {
      console.error('[AudioTest] Stop recording error:', error);
      Alert.alert('Recording Error', error.message);
      setRecordingStatus('idle');
    }
  }

  async function handlePlayLastRecording() {
    if (!lastRecordedBlob) {
      Alert.alert('No Recording', 'Please record audio first');
      return;
    }

    try {
      setPlaybackStatus('Playing last recording...');
      const duration = await audioPlayer.play(lastRecordedBlob);
      setPlaybackStatus(`Playback complete (${duration.toFixed(2)}s)`);
    } catch (error: any) {
      console.error('[AudioTest] Playback error:', error);
      Alert.alert('Playback Error', error.message);
      setPlaybackStatus('Playback failed');
    }
  }

  async function handlePlayTestAudio() {
    // Create a test audio blob (silent audio for testing)
    // In a real scenario, this would be audio from the server
    try {
      setPlaybackStatus('Playing test audio...');

      // For now, we'll show an alert since we don't have a test audio file
      Alert.alert(
        'Test Audio',
        'This would play a test audio file. Try recording and playing back instead.'
      );
      setPlaybackStatus('Test audio not implemented');
    } catch (error: any) {
      console.error('[AudioTest] Test playback error:', error);
      Alert.alert('Playback Error', error.message);
      setPlaybackStatus('Test playback failed');
    }
  }

  function handleStopPlayback() {
    audioPlayer.stop();
    setPlaybackStatus('Playback stopped');
  }

  return (
    <ScrollView className="flex-1 bg-white dark:bg-black">
      <View className="p-6">
        {/* Header */}
        <Text className="text-3xl font-bold text-gray-900 dark:text-white mb-2">
          Audio Test
        </Text>
        <Text className="text-base text-gray-600 dark:text-gray-400 mb-8">
          Test audio recording and playback functionality
        </Text>

        {/* Permission Status */}
        <View className="mb-8">
          <Text className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
            Permission Status
          </Text>
          <View className={`p-4 rounded-lg ${permissionGranted ? 'bg-green-100 dark:bg-green-900' : 'bg-red-100 dark:bg-red-900'}`}>
            <Text className={`text-base ${permissionGranted ? 'text-green-800 dark:text-green-200' : 'text-red-800 dark:text-red-200'}`}>
              {permissionGranted ? '✓ Microphone permission granted' : '✗ Microphone permission denied'}
            </Text>
          </View>
        </View>

        {/* Recording Section */}
        <View className="mb-8">
          <Text className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
            Audio Recording
          </Text>

          {/* Recording Status */}
          <View className="mb-4 p-4 bg-gray-100 dark:bg-gray-800 rounded-lg">
            <Text className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Status
            </Text>
            <Text className="text-base text-gray-900 dark:text-white">
              {recordingStatus === 'idle' && 'Ready to record'}
              {recordingStatus === 'recording' && '🔴 Recording...'}
              {recordingStatus === 'processing' && 'Processing...'}
            </Text>
          </View>

          {/* Recording Controls */}
          <View className="flex-row gap-3 mb-4">
            <Pressable
              onPress={handleStartRecording}
              disabled={recordingStatus !== 'idle' || !permissionGranted}
              className={`flex-1 p-4 rounded-lg items-center ${
                recordingStatus !== 'idle' || !permissionGranted
                  ? 'bg-gray-300 dark:bg-gray-700'
                  : 'bg-blue-500 dark:bg-blue-600'
              }`}
            >
              <Text className={`text-base font-semibold ${
                recordingStatus !== 'idle' || !permissionGranted
                  ? 'text-gray-500 dark:text-gray-400'
                  : 'text-white'
              }`}>
                Start Recording
              </Text>
            </Pressable>

            <Pressable
              onPress={handleStopRecording}
              disabled={recordingStatus !== 'recording'}
              className={`flex-1 p-4 rounded-lg items-center ${
                recordingStatus !== 'recording'
                  ? 'bg-gray-300 dark:bg-gray-700'
                  : 'bg-red-500 dark:bg-red-600'
              }`}
            >
              <Text className={`text-base font-semibold ${
                recordingStatus !== 'recording'
                  ? 'text-gray-500 dark:text-gray-400'
                  : 'text-white'
              }`}>
                Stop Recording
              </Text>
            </Pressable>
          </View>

          {/* Last Recording Info */}
          {lastRecordingSize !== null && (
            <View className="p-4 bg-blue-50 dark:bg-blue-950 rounded-lg">
              <Text className="text-sm font-medium text-blue-700 dark:text-blue-300 mb-1">
                Last Recording
              </Text>
              <Text className="text-base text-blue-900 dark:text-blue-100">
                Size: {lastRecordingSize} bytes
              </Text>
              <Text className="text-sm text-blue-600 dark:text-blue-400 mt-1">
                Type: audio/m4a
              </Text>
            </View>
          )}
        </View>

        {/* Playback Section */}
        <View className="mb-8">
          <Text className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
            Audio Playback
          </Text>

          {/* Playback Status */}
          <View className="mb-4 p-4 bg-gray-100 dark:bg-gray-800 rounded-lg">
            <Text className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Status
            </Text>
            <Text className="text-base text-gray-900 dark:text-white">
              {playbackStatus}
            </Text>
          </View>

          {/* Playback Controls */}
          <View className="gap-3">
            <Pressable
              onPress={handlePlayLastRecording}
              disabled={!lastRecordedBlob}
              className={`p-4 rounded-lg items-center ${
                !lastRecordedBlob
                  ? 'bg-gray-300 dark:bg-gray-700'
                  : 'bg-green-500 dark:bg-green-600'
              }`}
            >
              <Text className={`text-base font-semibold ${
                !lastRecordedBlob
                  ? 'text-gray-500 dark:text-gray-400'
                  : 'text-white'
              }`}>
                Play Last Recording
              </Text>
            </Pressable>

            <Pressable
              onPress={handlePlayTestAudio}
              className="p-4 rounded-lg items-center bg-purple-500 dark:bg-purple-600"
            >
              <Text className="text-base font-semibold text-white">
                Play Test Audio
              </Text>
            </Pressable>

            <Pressable
              onPress={handleStopPlayback}
              className="p-4 rounded-lg items-center bg-orange-500 dark:bg-orange-600"
            >
              <Text className="text-base font-semibold text-white">
                Stop Playback
              </Text>
            </Pressable>
          </View>
        </View>

        {/* Audio Settings Info */}
        <View className="p-4 bg-gray-50 dark:bg-gray-900 rounded-lg">
          <Text className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Audio Configuration
          </Text>
          <Text className="text-sm text-gray-600 dark:text-gray-400 mb-1">
            • Sample Rate: 16000 Hz
          </Text>
          <Text className="text-sm text-gray-600 dark:text-gray-400 mb-1">
            • Channels: 1 (Mono)
          </Text>
          <Text className="text-sm text-gray-600 dark:text-gray-400 mb-1">
            • Format: M4A/AAC
          </Text>
          <Text className="text-sm text-gray-600 dark:text-gray-400">
            • Optimized for voice/speech
          </Text>
        </View>
      </View>
    </ScrollView>
  );
}
