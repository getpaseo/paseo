import { View, Text } from 'react-native';

interface ConnectionStatusProps {
  isConnected: boolean;
}

export function ConnectionStatus({ isConnected }: ConnectionStatusProps) {
  return (
    <View className="px-4 py-3 border-b border-zinc-800">
      <View className="flex-row items-center">
        <View className={`w-2 h-2 rounded-full mr-2 ${isConnected ? 'bg-green-500' : 'bg-red-500'}`} />
        <Text className={isConnected ? 'text-green-500 text-sm' : 'text-red-500 text-sm'}>
          {isConnected ? 'Connected' : 'Disconnected'}
        </Text>
      </View>
    </View>
  );
}
