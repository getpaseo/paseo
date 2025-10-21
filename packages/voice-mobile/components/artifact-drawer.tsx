import { View, Text, ScrollView, Pressable, Modal } from 'react-native';
import { useEffect } from 'react';

export interface Artifact {
  id: string;
  type: 'markdown' | 'diff' | 'image' | 'code';
  title: string;
  content: string;
  isBase64: boolean;
}

interface ArtifactDrawerProps {
  artifact: Artifact | null;
  onClose: () => void;
}

export function ArtifactDrawer({ artifact, onClose }: ArtifactDrawerProps) {
  useEffect(() => {
    if (!artifact) return;
    console.log('[ArtifactDrawer] Showing artifact:', artifact.id, artifact.type, artifact.title);
  }, [artifact]);

  if (!artifact) {
    return null;
  }

  // Decode content if base64
  const content = artifact.isBase64 ? atob(artifact.content) : artifact.content;

  // Type badge colors
  const typeColors = {
    markdown: 'bg-blue-600',
    diff: 'bg-purple-600',
    image: 'bg-green-600',
    code: 'bg-orange-600',
  };

  return (
    <Modal
      visible={!!artifact}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View className="flex-1 bg-black">
        {/* Header */}
        <View className="pt-16 pb-4 px-4 border-b border-zinc-800">
          <View className="flex-row items-center justify-between">
            <View className="flex-1 mr-4">
              <Text className="text-white text-xl font-bold" numberOfLines={2}>
                {artifact.title}
              </Text>
            </View>
            <View className="flex-row items-center gap-2">
              <View className={`${typeColors[artifact.type]} px-3 py-1 rounded-full`}>
                <Text className="text-white text-xs font-semibold uppercase">
                  {artifact.type}
                </Text>
              </View>
              <Pressable
                onPress={onClose}
                className="bg-zinc-800 w-10 h-10 rounded-full items-center justify-center"
              >
                <Text className="text-white text-xl font-bold">×</Text>
              </Pressable>
            </View>
          </View>
        </View>

        {/* Content */}
        <ScrollView className="flex-1" contentContainerClassName="p-4">
          {artifact.type === 'image' ? (
            <View className="items-center justify-center">
              <Text className="text-zinc-400 text-sm">
                Image viewing not yet implemented
              </Text>
              <Text className="text-zinc-600 text-xs mt-2">
                Base64 image data received
              </Text>
            </View>
          ) : (
            <View className="bg-zinc-900 rounded-lg p-4 border border-zinc-800">
              <ScrollView horizontal showsHorizontalScrollIndicator={true}>
                <Text
                  className="text-zinc-300 text-sm font-mono"
                  style={{ fontFamily: 'monospace' }}
                >
                  {content}
                </Text>
              </ScrollView>
            </View>
          )}

          {/* Metadata */}
          <View className="mt-4 bg-zinc-900 rounded-lg p-3 border border-zinc-800">
            <Text className="text-zinc-500 text-xs font-semibold mb-2">METADATA</Text>
            <View className="space-y-1">
              <View className="flex-row">
                <Text className="text-zinc-500 text-xs w-20">ID:</Text>
                <Text className="text-zinc-400 text-xs flex-1 font-mono">
                  {artifact.id}
                </Text>
              </View>
              <View className="flex-row">
                <Text className="text-zinc-500 text-xs w-20">Type:</Text>
                <Text className="text-zinc-400 text-xs">{artifact.type}</Text>
              </View>
              <View className="flex-row">
                <Text className="text-zinc-500 text-xs w-20">Encoding:</Text>
                <Text className="text-zinc-400 text-xs">
                  {artifact.isBase64 ? 'Base64' : 'Plain text'}
                </Text>
              </View>
              <View className="flex-row">
                <Text className="text-zinc-500 text-xs w-20">Size:</Text>
                <Text className="text-zinc-400 text-xs">
                  {content.length.toLocaleString()} characters
                </Text>
              </View>
            </View>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}
