import { Pressable, View, Text, Animated } from 'react-native';
import { useEffect, useRef } from 'react';
import { StyleSheet } from 'react-native-unistyles';

interface VoiceButtonProps {
  state: 'idle' | 'recording' | 'processing' | 'playing';
  onPress: () => void;
  disabled?: boolean;
}

const styles = StyleSheet.create((theme) => ({
  container: {
    alignItems: 'center',
    gap: theme.spacing[4],
  },
  pressable: {
    opacity: 1,
  },
  pressableDisabled: {
    opacity: 0.5,
  },
  button: {
    width: 80,
    height: 80,
    borderRadius: theme.borderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  buttonIdle: {
    backgroundColor: theme.colors.surface2,
  },
  buttonRecording: {
    backgroundColor: theme.colors.destructive,
  },
  buttonProcessing: {
    backgroundColor: theme.colors.primary,
  },
  buttonPlaying: {
    backgroundColor: theme.colors.palette.green[500],
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  // Recording icon
  recordingIcon: {
    width: 24,
    height: 24,
    backgroundColor: theme.colors.foreground,
    borderRadius: theme.borderRadius.md,
  },
  // Processing icon
  processingIconContainer: {
    width: 24,
    height: 24,
  },
  processingDot: {
    width: 6,
    height: 6,
    backgroundColor: theme.colors.primaryForeground,
    borderRadius: theme.borderRadius.full,
    position: 'absolute',
  },
  processingDotTop: {
    top: 0,
    left: 12,
  },
  processingDotRight: {
    top: 12,
    right: 0,
  },
  processingDotBottom: {
    bottom: 0,
    left: 12,
  },
  // Playing icon
  playingIconContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[1],
  },
  playingBar: {
    backgroundColor: theme.colors.foreground,
    borderRadius: theme.borderRadius.sm,
  },
  playingBar1: {
    width: 4,
    height: 16,
  },
  playingBar2: {
    width: 4,
    height: 24,
  },
  playingBar3: {
    width: 4,
    height: 12,
  },
  // Idle icon (microphone)
  micContainer: {
    width: 24,
    height: 32,
    position: 'relative',
  },
  micCapsule: {
    position: 'absolute',
    bottom: 0,
    left: 4,
    width: 16,
    height: 24,
    backgroundColor: theme.colors.foreground,
    borderTopLeftRadius: 999,
    borderTopRightRadius: 999,
  },
  micBase: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    width: 24,
    height: 6,
    backgroundColor: theme.colors.foreground,
    borderRadius: theme.borderRadius.full,
  },
}));

export function VoiceButton({ state, onPress, disabled = false }: VoiceButtonProps) {
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (state === 'recording') {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.2,
            duration: 800,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 800,
            useNativeDriver: true,
          }),
        ])
      ).start();
    } else {
      pulseAnim.setValue(1);
    }
  }, [state, pulseAnim]);

  const getButtonStyle = () => {
    switch (state) {
      case 'recording':
        return styles.buttonRecording;
      case 'processing':
        return styles.buttonProcessing;
      case 'playing':
        return styles.buttonPlaying;
      default:
        return styles.buttonIdle;
    }
  };

  const getIcon = () => {
    switch (state) {
      case 'recording':
        return <View style={styles.recordingIcon} />;
      case 'processing':
        return (
          <View style={styles.processingIconContainer}>
            <View style={[styles.processingDot, styles.processingDotTop]} />
            <View style={[styles.processingDot, styles.processingDotRight]} />
            <View style={[styles.processingDot, styles.processingDotBottom]} />
          </View>
        );
      case 'playing':
        return (
          <View style={styles.playingIconContainer}>
            <View style={[styles.playingBar, styles.playingBar1]} />
            <View style={[styles.playingBar, styles.playingBar2]} />
            <View style={[styles.playingBar, styles.playingBar3]} />
          </View>
        );
      default:
        return (
          <View style={styles.micContainer}>
            <View style={styles.micCapsule} />
            <View style={styles.micBase} />
          </View>
        );
    }
  };

  const getLabel = () => {
    switch (state) {
      case 'recording':
        return 'Recording...';
      case 'processing':
        return 'Processing...';
      case 'playing':
        return 'Playing...';
      default:
        return 'Tap to speak';
    }
  };

  return (
    <View style={styles.container}>
      <Pressable
        onPress={onPress}
        disabled={disabled}
        style={disabled ? styles.pressableDisabled : styles.pressable}
      >
        <Animated.View style={[styles.button, getButtonStyle(), { transform: [{ scale: pulseAnim }] }]}>
          {getIcon()}
        </Animated.View>
      </Pressable>
      <Text style={styles.label}>{getLabel()}</Text>
    </View>
  );
}
