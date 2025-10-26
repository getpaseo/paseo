import {
  View,
  TextInput,
  Pressable,
  NativeSyntheticEvent,
  TextInputContentSizeChangeEventData,
  Image,
  Alert,
} from "react-native";
import { useState } from "react";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Mic, ArrowUp, AudioLines, Square, Paperclip, X } from "lucide-react-native";
import * as ImagePicker from "expo-image-picker";
import { useSession } from "@/contexts/session-context";
import { useRealtime } from "@/contexts/realtime-context";
import { useAudioRecorder } from "@/hooks/use-audio-recorder";
import { FOOTER_HEIGHT } from "@/contexts/footer-controls-context";

interface AgentInputAreaProps {
  agentId: string;
}

const MIN_INPUT_HEIGHT = 40;
const MAX_INPUT_HEIGHT = 160;
const BASE_VERTICAL_PADDING = (FOOTER_HEIGHT - MIN_INPUT_HEIGHT) / 2;

export function AgentInputArea({ agentId }: AgentInputAreaProps) {
  const { theme } = useUnistyles();
  const { ws, sendAgentMessage, sendAgentAudio } = useSession();
  const { startRealtime } = useRealtime();
  const audioRecorder = useAudioRecorder();

  const [userInput, setUserInput] = useState("");
  const [inputHeight, setInputHeight] = useState(MIN_INPUT_HEIGHT);
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [selectedImages, setSelectedImages] = useState<Array<{ uri: string; mimeType: string }>>([]);

  async function handleSendMessage() {
    if (!userInput.trim() || !ws.isConnected) return;

    const message = userInput.trim();
    const imageUris = selectedImages.length > 0 ? selectedImages.map(img => img.uri) : undefined;
    
    setUserInput("");
    setSelectedImages([]);
    setInputHeight(MIN_INPUT_HEIGHT);
    setIsProcessing(true);

    try {
      await sendAgentMessage(agentId, message, imageUris);
    } catch (error) {
      console.error("[AgentInput] Failed to send message:", error);
    } finally {
      setIsProcessing(false);
    }
  }

  async function handlePickImage() {
    try {
      const permissionResult = await ImagePicker.requestMediaLibraryPermissionsAsync();
      
      if (!permissionResult.granted) {
        Alert.alert("Permission required", "Please allow access to your photo library to attach images.");
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: "images",
        allowsMultipleSelection: true,
        quality: 0.8,
      });

      if (!result.canceled && result.assets.length > 0) {
        const newImages = result.assets.map(asset => ({
          uri: asset.uri,
          mimeType: asset.mimeType || "image/jpeg",
        }));
        setSelectedImages(prev => [...prev, ...newImages]);
      }
    } catch (error) {
      console.error("[AgentInput] Failed to pick image:", error);
      Alert.alert("Error", "Failed to select image");
    }
  }

  function handleRemoveImage(index: number) {
    setSelectedImages(prev => prev.filter((_, i) => i !== index));
  }

  async function handleVoicePress() {
    if (isRecording) {
      // Stop recording
      try {
        setIsRecording(false);
        const audioData = await audioRecorder.stop();

        if (audioData) {
          setIsProcessing(true);
          console.log("[AgentInput] Audio recorded:", audioData.size, "bytes");

          try {
            // Send audio to agent for transcription and processing
            await sendAgentAudio(agentId, audioData);
            console.log("[AgentInput] Audio sent to agent");
          } catch (error) {
            console.error("[AgentInput] Failed to send audio:", error);
          } finally {
            setIsProcessing(false);
          }
        }
      } catch (error) {
        console.error("[AgentInput] Failed to stop recording:", error);
        setIsRecording(false);
        setIsProcessing(false);
      }
    } else {
      // Start recording
      try {
        await audioRecorder.start();
        setIsRecording(true);
      } catch (error) {
        console.error("[AgentInput] Failed to start recording:", error);
      }
    }
  }

  function handleContentSizeChange(
    event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>,
  ) {
    const contentHeight = event.nativeEvent.contentSize.height;
    const boundedHeight = Math.min(
      MAX_INPUT_HEIGHT,
      Math.max(MIN_INPUT_HEIGHT, contentHeight),
    );

    setInputHeight((currentHeight) => {
      if (Math.abs(currentHeight - boundedHeight) < 1) {
        return currentHeight;
      }

      return boundedHeight;
    });
  }

  const hasText = userInput.trim().length > 0;
  const hasImages = selectedImages.length > 0;

  return (
    <View style={styles.container}>
      {/* Image preview pills */}
      {hasImages && (
        <View style={styles.imagePreviewContainer}>
          {selectedImages.map((image, index) => (
            <View key={`${image.uri}-${index}`} style={styles.imagePill}>
              <Image source={{ uri: image.uri }} style={styles.imageThumbnail} />
              <Pressable onPress={() => handleRemoveImage(index)} style={styles.removeImageButton}>
                <X size={16} color={theme.colors.foreground} />
              </Pressable>
            </View>
          ))}
        </View>
      )}

      {/* Input row */}
      <View style={styles.inputRow}>
        {/* Attachment button */}
        {!isRecording && (
          <Pressable
            onPress={handlePickImage}
            disabled={!ws.isConnected}
            style={[
              styles.attachButton,
              !ws.isConnected && styles.buttonDisabled,
            ]}
          >
            <Paperclip size={20} color={theme.colors.foreground} />
          </Pressable>
        )}

        {/* Text input */}
        <TextInput
          value={userInput}
          onChangeText={setUserInput}
          placeholder="Message agent..."
          placeholderTextColor={theme.colors.mutedForeground}
          style={[
            styles.textInput,
            { height: inputHeight, minHeight: MIN_INPUT_HEIGHT, maxHeight: MAX_INPUT_HEIGHT },
          ]}
          multiline
          scrollEnabled={inputHeight >= MAX_INPUT_HEIGHT}
          onContentSizeChange={handleContentSizeChange}
          editable={!isRecording && ws.isConnected}
        />

        {/* Buttons */}
        <View style={styles.buttonRow}>
            {hasText || hasImages ? (
              // Send button when text is entered or images are selected
              <Pressable
                onPress={handleSendMessage}
                disabled={!ws.isConnected || isProcessing}
                style={[
                  styles.sendButton,
                  (!ws.isConnected || isProcessing) && styles.buttonDisabled,
                ]}
              >
                <ArrowUp size={20} color="white" />
              </Pressable>
            ) : (
              // Voice and Realtime buttons when no text
              <>
                {/* Voice recording button */}
                <Pressable
                  onPress={handleVoicePress}
                  disabled={!ws.isConnected}
                  style={[
                    styles.voiceButton,
                    !ws.isConnected && styles.buttonDisabled,
                    isRecording && styles.voiceButtonRecording,
                  ]}
                >
                  {isRecording ? (
                    <Square size={14} color="white" fill="white" />
                  ) : (
                    <Mic size={20} color={theme.colors.foreground} />
                  )}
                </Pressable>

                {/* Realtime button */}
                <Pressable
                  onPress={startRealtime}
                  disabled={!ws.isConnected}
                  style={[
                    styles.realtimeButton,
                    !ws.isConnected && styles.buttonDisabled,
                  ]}
                >
                  <AudioLines size={20} color={theme.colors.background} />
                </Pressable>
              </>
            )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "column",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: BASE_VERTICAL_PADDING,
    gap: theme.spacing[2],
    minHeight: FOOTER_HEIGHT,
  },
  imagePreviewContainer: {
    flexDirection: "row",
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
  imagePill: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.colors.muted,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[1],
    gap: theme.spacing[2],
  },
  imageThumbnail: {
    width: 40,
    height: 40,
    borderRadius: theme.borderRadius.md,
  },
  removeImageButton: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  attachButton: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  textInput: {
    flex: 1,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.muted,
    borderRadius: theme.borderRadius.lg,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  buttonRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.palette.blue[600],
    alignItems: "center",
    justifyContent: "center",
  },
  voiceButton: {
    width: 40,
    height: 40,
    borderRadius: theme.borderRadius.full,
    backgroundColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
  },
  voiceButtonRecording: {
    backgroundColor: theme.colors.destructive,
  },
  realtimeButton: {
    width: 40,
    height: 40,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accentForeground,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonDisabled: {
    opacity: 0.5,
  },
}));
