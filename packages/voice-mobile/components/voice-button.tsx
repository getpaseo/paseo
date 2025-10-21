import { Pressable, View, Text, Animated } from 'react-native';
import { useEffect, useRef } from 'react';

interface VoiceButtonProps {
  state: 'idle' | 'recording' | 'processing' | 'playing';
  onPress: () => void;
  disabled?: boolean;
}

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
        return 'bg-red-500';
      case 'processing':
        return 'bg-blue-500';
      case 'playing':
        return 'bg-green-500';
      default:
        return 'bg-zinc-700';
    }
  };

  const getIcon = () => {
    switch (state) {
      case 'recording':
        return (
          <View className="w-6 h-6 bg-white rounded" />
        );
      case 'processing':
        return (
          <View className="w-6 h-6">
            <View className="w-1.5 h-1.5 bg-white rounded-full absolute top-0 left-3" />
            <View className="w-1.5 h-1.5 bg-white rounded-full absolute top-3 right-0" />
            <View className="w-1.5 h-1.5 bg-white rounded-full absolute bottom-0 left-3" />
          </View>
        );
      case 'playing':
        return (
          <View className="flex-row items-center gap-1">
            <View className="w-1 h-4 bg-white rounded" />
            <View className="w-1 h-6 bg-white rounded" />
            <View className="w-1 h-3 bg-white rounded" />
          </View>
        );
      default:
        return (
          <View className="w-6 h-8 relative">
            <View className="absolute bottom-0 left-1/2 -translate-x-1/2 w-4 h-6 bg-white rounded-t-full" />
            <View className="absolute bottom-0 left-1/2 -translate-x-1/2 w-6 h-1.5 bg-white rounded-full" />
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
    <View className="items-center gap-4">
      <Pressable
        onPress={onPress}
        disabled={disabled}
        className={`${disabled ? 'opacity-50' : 'opacity-100'}`}
      >
        <Animated.View
          style={{ transform: [{ scale: pulseAnim }] }}
          className={`w-20 h-20 rounded-full ${getButtonStyle()} items-center justify-center shadow-lg`}
        >
          {getIcon()}
        </Animated.View>
      </Pressable>
      <Text className="text-zinc-400 text-sm">{getLabel()}</Text>
    </View>
  );
}
