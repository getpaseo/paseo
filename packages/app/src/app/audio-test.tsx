import { View, Text, Pressable, ScrollView, Alert } from 'react-native';
import { useState, useEffect } from 'react';
import { StyleSheet } from 'react-native-unistyles';
import { useAudioRecorder } from '../hooks/use-audio-recorder';
import { useAudioPlayer } from '../hooks/use-audio-player';
import { getRecordingPermissionsAsync, requestRecordingPermissionsAsync } from 'expo-audio';

const styles = StyleSheet.create((theme) => ({
  scrollView: {
    flex: 1,
    backgroundColor: theme.colors.palette.white,
  },
  scrollViewDark: {
    backgroundColor: theme.colors.surface0,
  },
  container: {
    padding: theme.spacing[6],
  },
  title: {
    fontSize: theme.fontSize['3xl'],
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.palette.gray[900],
    marginBottom: theme.spacing[2],
  },
  titleDark: {
    color: theme.colors.foreground,
  },
  subtitle: {
    fontSize: theme.fontSize.base,
    color: theme.colors.palette.gray[600],
    marginBottom: theme.spacing[8],
  },
  subtitleDark: {
    color: theme.colors.foregroundMuted,
  },
  section: {
    marginBottom: theme.spacing[8],
  },
  sectionTitle: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.palette.gray[900],
    marginBottom: theme.spacing[2],
  },
  sectionTitleDark: {
    color: theme.colors.foreground,
  },
  permissionCard: {
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
  },
  permissionGranted: {
    backgroundColor: theme.colors.palette.green[100],
  },
  permissionGrantedDark: {
    backgroundColor: theme.colors.palette.green[900],
  },
  permissionDenied: {
    backgroundColor: theme.colors.palette.red[100],
  },
  permissionDeniedDark: {
    backgroundColor: theme.colors.palette.red[900],
  },
  permissionText: {
    fontSize: theme.fontSize.base,
  },
  permissionTextGranted: {
    color: theme.colors.palette.green[800],
  },
  permissionTextGrantedDark: {
    color: theme.colors.palette.green[200],
  },
  permissionTextDenied: {
    color: theme.colors.palette.red[800],
  },
  permissionTextDeniedDark: {
    color: theme.colors.palette.red[200],
  },
  statusCard: {
    marginBottom: theme.spacing[4],
    padding: theme.spacing[4],
    backgroundColor: theme.colors.palette.gray[100],
    borderRadius: theme.borderRadius.lg,
  },
  statusCardDark: {
    backgroundColor: theme.colors.surface2,
  },
  statusLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.palette.gray[700],
    marginBottom: theme.spacing[1],
  },
  statusLabelDark: {
    color: theme.colors.foregroundMuted,
  },
  statusValue: {
    fontSize: theme.fontSize.base,
    color: theme.colors.palette.gray[900],
  },
  statusValueDark: {
    color: theme.colors.foreground,
  },
  controlsRow: {
    flexDirection: 'row',
    gap: theme.spacing[3],
    marginBottom: theme.spacing[4],
  },
  button: {
    flex: 1,
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    alignItems: 'center',
  },
  buttonBlue: {
    backgroundColor: theme.colors.palette.blue[500],
  },
  buttonBlueDark: {
    backgroundColor: theme.colors.palette.blue[600],
  },
  buttonRed: {
    backgroundColor: theme.colors.palette.red[500],
  },
  buttonRedDark: {
    backgroundColor: theme.colors.palette.red[600],
  },
  buttonGreen: {
    backgroundColor: theme.colors.palette.green[500],
  },
  buttonGreenDark: {
    backgroundColor: theme.colors.palette.green[600],
  },
  buttonPurple: {
    backgroundColor: theme.colors.palette.purple[500],
  },
  buttonPurpleDark: {
    backgroundColor: theme.colors.palette.purple[600],
  },
  buttonOrange: {
    backgroundColor: theme.colors.palette.orange[500],
  },
  buttonOrangeDark: {
    backgroundColor: theme.colors.palette.orange[600],
  },
  buttonDisabled: {
    backgroundColor: theme.colors.palette.gray[300],
  },
  buttonDisabledDark: {
    backgroundColor: theme.colors.surface2,
  },
  buttonText: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.palette.white,
  },
  buttonTextDisabled: {
    color: theme.colors.palette.gray[500],
  },
  buttonTextDisabledDark: {
    color: theme.colors.foregroundMuted,
  },
  fullWidthButton: {
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    alignItems: 'center',
  },
  infoCard: {
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.palette.blue[50],
  },
  infoCardDark: {
    backgroundColor: theme.colors.palette.blue[950],
  },
  infoCardLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.palette.blue[700],
    marginBottom: theme.spacing[1],
  },
  infoCardLabelDark: {
    color: theme.colors.palette.blue[300],
  },
  infoCardValue: {
    fontSize: theme.fontSize.base,
    color: theme.colors.palette.blue[900],
  },
  infoCardValueDark: {
    color: theme.colors.palette.blue[100],
  },
  infoCardSubtext: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.palette.blue[600],
    marginTop: theme.spacing[1],
  },
  infoCardSubtextDark: {
    color: theme.colors.palette.blue[400],
  },
  configCard: {
    padding: theme.spacing[4],
    backgroundColor: theme.colors.palette.gray[50],
    borderRadius: theme.borderRadius.lg,
  },
  configCardDark: {
    backgroundColor: theme.colors.surface2,
  },
  configTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.palette.gray[700],
    marginBottom: theme.spacing[2],
  },
  configTitleDark: {
    color: theme.colors.foregroundMuted,
  },
  configText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.palette.gray[600],
    marginBottom: theme.spacing[1],
  },
  configTextDark: {
    color: theme.colors.foregroundMuted,
  },
  gap3: {
    gap: theme.spacing[3],
  },
}));

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
    <ScrollView style={[styles.scrollView, styles.scrollViewDark]}>
      <View style={styles.container}>
        {/* Header */}
        <Text style={[styles.title, styles.titleDark]}>
          Audio Test
        </Text>
        <Text style={[styles.subtitle, styles.subtitleDark]}>
          Test audio recording and playback functionality
        </Text>

        {/* Permission Status */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, styles.sectionTitleDark]}>
            Permission Status
          </Text>
          <View style={[
            styles.permissionCard,
            permissionGranted ? styles.permissionGrantedDark : styles.permissionDeniedDark
          ]}>
            <Text style={[
              styles.permissionText,
              permissionGranted ? styles.permissionTextGrantedDark : styles.permissionTextDeniedDark
            ]}>
              {permissionGranted ? '✓ Microphone permission granted' : '✗ Microphone permission denied'}
            </Text>
          </View>
        </View>

        {/* Recording Section */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, styles.sectionTitleDark]}>
            Audio Recording
          </Text>

          {/* Recording Status */}
          <View style={[styles.statusCard, styles.statusCardDark]}>
            <Text style={[styles.statusLabel, styles.statusLabelDark]}>
              Status
            </Text>
            <Text style={[styles.statusValue, styles.statusValueDark]}>
              {recordingStatus === 'idle' && 'Ready to record'}
              {recordingStatus === 'recording' && '🔴 Recording...'}
              {recordingStatus === 'processing' && 'Processing...'}
            </Text>
          </View>

          {/* Recording Controls */}
          <View style={styles.controlsRow}>
            <Pressable
              onPress={handleStartRecording}
              disabled={recordingStatus !== 'idle' || !permissionGranted}
              style={[
                styles.button,
                (recordingStatus !== 'idle' || !permissionGranted)
                  ? styles.buttonDisabledDark
                  : styles.buttonBlueDark
              ]}
            >
              <Text style={[
                styles.buttonText,
                (recordingStatus !== 'idle' || !permissionGranted) && styles.buttonTextDisabledDark
              ]}>
                Start Recording
              </Text>
            </Pressable>

            <Pressable
              onPress={handleStopRecording}
              disabled={recordingStatus !== 'recording'}
              style={[
                styles.button,
                recordingStatus !== 'recording'
                  ? styles.buttonDisabledDark
                  : styles.buttonRedDark
              ]}
            >
              <Text style={[
                styles.buttonText,
                recordingStatus !== 'recording' && styles.buttonTextDisabledDark
              ]}>
                Stop Recording
              </Text>
            </Pressable>
          </View>

          {/* Last Recording Info */}
          {lastRecordingSize !== null && (
            <View style={[styles.infoCard, styles.infoCardDark]}>
              <Text style={[styles.infoCardLabel, styles.infoCardLabelDark]}>
                Last Recording
              </Text>
              <Text style={[styles.infoCardValue, styles.infoCardValueDark]}>
                Size: {lastRecordingSize} bytes
              </Text>
              <Text style={[styles.infoCardSubtext, styles.infoCardSubtextDark]}>
                Type: audio/m4a
              </Text>
            </View>
          )}
        </View>

        {/* Playback Section */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, styles.sectionTitleDark]}>
            Audio Playback
          </Text>

          {/* Playback Status */}
          <View style={[styles.statusCard, styles.statusCardDark]}>
            <Text style={[styles.statusLabel, styles.statusLabelDark]}>
              Status
            </Text>
            <Text style={[styles.statusValue, styles.statusValueDark]}>
              {playbackStatus}
            </Text>
          </View>

          {/* Playback Controls */}
          <View style={styles.gap3}>
            <Pressable
              onPress={handlePlayLastRecording}
              disabled={!lastRecordedBlob}
              style={[
                styles.fullWidthButton,
                !lastRecordedBlob
                  ? styles.buttonDisabledDark
                  : styles.buttonGreenDark
              ]}
            >
              <Text style={[
                styles.buttonText,
                !lastRecordedBlob && styles.buttonTextDisabledDark
              ]}>
                Play Last Recording
              </Text>
            </Pressable>

            <Pressable
              onPress={handlePlayTestAudio}
              style={[styles.fullWidthButton, styles.buttonPurpleDark]}
            >
              <Text style={styles.buttonText}>
                Play Test Audio
              </Text>
            </Pressable>

            <Pressable
              onPress={handleStopPlayback}
              style={[styles.fullWidthButton, styles.buttonOrangeDark]}
            >
              <Text style={styles.buttonText}>
                Stop Playback
              </Text>
            </Pressable>
          </View>
        </View>

        {/* Audio Settings Info */}
        <View style={[styles.configCard, styles.configCardDark]}>
          <Text style={[styles.configTitle, styles.configTitleDark]}>
            Audio Configuration
          </Text>
          <Text style={[styles.configText, styles.configTextDark]}>
            • Sample Rate: 16000 Hz
          </Text>
          <Text style={[styles.configText, styles.configTextDark]}>
            • Channels: 1 (Mono)
          </Text>
          <Text style={[styles.configText, styles.configTextDark]}>
            • Format: M4A/AAC
          </Text>
          <Text style={[styles.configText, styles.configTextDark]}>
            • Optimized for voice/speech
          </Text>
        </View>
      </View>
    </ScrollView>
  );
}
