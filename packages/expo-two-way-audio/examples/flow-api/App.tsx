// EventTarget polyfill is required for the Flow SDK to work in React Native
import "event-target-polyfill";
import { Buffer } from "buffer";
import { Button, StyleSheet, Text, View } from "react-native";
import { Platform } from "react-native";

import {
  type MicrophoneDataCallback,
  type VolumeLevelCallback,
  getMicrophoneModeIOS,
  initialize,
  playPCMData,
  toggleRecording,
  useExpoTwoWayAudioEventListener,
  useIsRecording,
  useMicrophonePermissions,
} from "@speechmatics/expo-two-way-audio";

import {
  FlowProvider,
  type RecognitionAlternative,
  useFlow,
  useFlowEventListener,
} from "@speechmatics/flow-client-react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useSharedValue } from "react-native-reanimated";
import { getFlowAPIJwt } from "./auth";
import VolumeDisplay from "./volume-display";

export default function App() {
  const [micPermission, requestMicPermission] = useMicrophonePermissions();
  console.log(micPermission);

  if (!micPermission?.granted) {
    return (
      <View style={styles.container}>
        <Text>Mic permission: {micPermission?.status}</Text>
        <Button
          title={micPermission?.canAskAgain ? "Request permission" : "Cannot request permissions"}
          disabled={!micPermission?.canAskAgain}
          onPress={requestMicPermission}
        />
      </View>
    );
  }

  return (
    <FlowProvider appId="flow-api-example" websocketBinaryType="arraybuffer">
      <FlowTest />
    </FlowProvider>
  );
}

export function FlowTest() {
  const [isConnectedToFlow, setIsConnectedToFlow] = useState(false);
  const [isConnectingToFlow, setIsConnectingToFlow] = useState(false);
  const [audioInitialized, setAudioInitialized] = useState(false);
  const inputVolumeLevel = useSharedValue(0.0);
  const outputVolumeLevel = useSharedValue(0.0);
  const isRecording = useIsRecording();
  const { startConversation, endConversation, sendAudio } = useFlow();

  // Initialize Expo Two Way Audio
  useEffect(() => {
    const initializeAudio = async () => {
      await initialize();
      setAudioInitialized(true);
    };

    initializeAudio();
  }, []);

  // Setup a handler for the "message" event from Flow API
  useFlowEventListener("message", ({ data }) => {
    // For the purpose of this example, just print the content of the transcript
    if (data.message === "AddTranscript") {
      for (const result of data.results as {
        alternatives: Array<RecognitionAlternative>;
      }[]) {
        for (const alternative of result.alternatives as Array<RecognitionAlternative>) {
          console.log(alternative.content);
        }
      }
    }
  });

  // Setup a handler for the "agentAudio" event from Flow API
  useFlowEventListener("agentAudio", (audio) => {
    // Even though Int16Array is a more natural representation for PCM16_sle,
    // Expo Modules API uses a convertible type for arrays of bytes and it needs Uint8Array in the JS side.
    // This is converted to a `Data` type in Swift and to a `kotlin.ByteArray` in Kotlin.
    // More info here: https://docs.expo.dev/modules/module-api/#convertibles
    // For this reason, the Expo Two Way Audio library requires a Uint8Array argument for the `playPCMData` function.
    const byteArray = new Uint8Array(audio.data.buffer);
    playPCMData(byteArray);
  });

  // Setup a handler for the "onMicrophoneData" event from Expo Two Way Audio module
  useExpoTwoWayAudioEventListener(
    "onMicrophoneData",
    useCallback<MicrophoneDataCallback>(
      (event) => {
        // We send the audio bytes to the Flow API
        sendAudio(event.data.buffer);
      },
      [sendAudio],
    ),
  );

  // Setup a handler for the "onInputVolumeLevelData" event from Expo Two Way Audio module.
  // This event is triggered when the input volume level changes.
  useExpoTwoWayAudioEventListener(
    "onInputVolumeLevelData",
    useCallback<VolumeLevelCallback>(
      (event) => {
        // We update the react-native-reanimated shared value for the input volume (microphone).
        // This allow us to create animations for the microphone volume based on this shared value.
        inputVolumeLevel.value = event.data;
      },
      [inputVolumeLevel],
    ),
  );

  // Setup a handler for the "onOutputVolumeLevelData" event from Expo Two Way Audio module.
  // This event is triggered when the output volume level changes.
  useExpoTwoWayAudioEventListener(
    "onOutputVolumeLevelData",
    useCallback<VolumeLevelCallback>(
      (event) => {
        // We update the react-native-reanimated shared value for the output volume (speaker).
        // This allow us to create animations for the speaker volume based on this shared value.
        outputVolumeLevel.value = event.data;
      },
      [outputVolumeLevel],
    ),
  );

  // Handle clicks to the 'Connect/Disconnect' button
  const handleToggleConnect = useCallback(async () => {
    setIsConnectingToFlow(true);
    if (isConnectedToFlow) {
      endConversation();
      setIsConnectedToFlow(false);
    } else {
      let jwt;
      try {
        // WARNING: This function is used for the purpose of this example only.
        // In a real-world scenario, you should not expose your API key in your client-side code.
        // Instead, you should create a server-side endpoint that generates the JWT for you.
        jwt = await getFlowAPIJwt(
          // EXPO_PUBLIC_SPEECHMATICS_API_KEY could be set in your .env file
          process.env.EXPO_PUBLIC_SPEECHMATICS_API_KEY,
        );
      } catch (error) {
        console.error("Failed to get JWT:", error);
        setIsConnectingToFlow(false);
        return;
      }

      try {
        await startConversation(jwt, {
          config: {
            template_id: "flow-service-assistant-humphrey",
            template_variables: {
              timezone: "Europe/London",
            },
          },
          // `audioFormat` is optional. The value below is the default:
          audioFormat: {
            type: "raw",
            encoding: "pcm_s16le", // this can also be set to 'pcm_f32le' for 32-bit Float
            sample_rate: 16000,
          },
        });
        setIsConnectedToFlow(true);
      } catch (error) {
        console.error("Failed to start conversation:", error);
      }
    }
    setIsConnectingToFlow(false);
  }, [isConnectedToFlow, startConversation, endConversation]);

  // Handle clicks to the 'Mute/Unmute' button
  const handleToggleMute = useCallback(() => {
    toggleRecording(!isRecording);
  }, [isRecording]);

  return (
    <View style={styles.container}>
      <View style={styles.VolumeDisplayContainer}>
        <View style={styles.volumeDisplay}>
          <VolumeDisplay
            volumeLevel={outputVolumeLevel}
            color="#7ECFBD"
            minSize={130}
            maxSize={180}
          />
        </View>
        <View style={styles.volumeDisplay}>
          <VolumeDisplay
            volumeLevel={inputVolumeLevel}
            color="#4CBBA5"
            minSize={70}
            maxSize={120}
          />
        </View>
      </View>
      <View>
        <Text>
          {isConnectedToFlow
            ? isRecording
              ? "I'm ready to listen. Try saying something!"
              : "Muted. Unmute to start a conversation"
            : isConnectingToFlow
              ? "Connecting..."
              : "Disconnected"}
        </Text>
      </View>
      <View style={styles.bottomBar}>
        <View style={styles.buttonContainer}>
          <Button
            title={isConnectedToFlow ? "Disconnect" : "Connect"}
            disabled={isConnectingToFlow || !audioInitialized}
            onPress={handleToggleConnect}
          />

          <Button
            title={isRecording ? "Mute" : "Unmute"}
            disabled={!isConnectedToFlow || !audioInitialized}
            onPress={handleToggleMute}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "space-evenly",
    padding: 50,
  },
  buttonContainer: {
    flexDirection: "row",
    justifyContent: "space-around",
    width: "100%",
    marginBottom: 20,
  },
  bottomBar: {
    position: "absolute",
    bottom: 0,
    width: "100%",
    padding: 20,
    borderTopWidth: 1,
    borderTopColor: "lightgray",
  },
  VolumeDisplayContainer: {
    position: "relative",
    width: 150,
    height: 150,
    alignItems: "center",
    justifyContent: "center",
  },
  volumeDisplay: {
    position: "absolute",
  },
});
