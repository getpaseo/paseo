import { useCallback, useLayoutEffect, useState } from "react";
import { Button, Text, View } from "react-native";
import { useAnimatedReaction, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN, scheduleOnUI } from "react-native-worklets";
import { RetainedPanel } from "@/components/retained-panel";
import { useStatusRingRotation } from "@/components/status-ring/clock";
import { StatusRing } from "@/components/status-ring";

interface Sample {
  updates: number;
  rotation: number;
}

declare global {
  var __ringSamples: Record<string, Sample>;
  var __ringReaders: Record<string, () => void>;
}

function recordSample(name: string, value: { updates: number; rotation: number }) {
  globalThis.__ringSamples[name] = value;
}

function Probe({ name }: { name: string }) {
  const rotation = useStatusRingRotation();
  const updates = useSharedValue(0);
  useAnimatedReaction(
    () => rotation.value,
    () => {
      updates.value += 1;
    },
  );
  // Read the real UI runtime, without scheduling a continuous JS observer.
  useLayoutEffect(() => {
    globalThis.__ringSamples ??= {};
    globalThis.__ringReaders ??= {};
    globalThis.__ringReaders[name] = () =>
      scheduleOnUI(() => {
        "worklet";
        const sample = { updates: updates.value, rotation: rotation.value };
        scheduleOnRN(recordSample, name, sample);
      });
    return () => {
      delete globalThis.__ringReaders[name];
    };
  }, [name, rotation, updates]);
  return <StatusRing />;
}

const containerStyle = { flex: 1, padding: 60, backgroundColor: "white" };

export default function NativeRingRegression() {
  const [first, setFirst] = useState(true);
  const [second, setSecond] = useState(true);
  const toggleFirst = useCallback(() => setFirst((value) => !value), []);
  const toggleSecond = useCallback(() => setSecond((value) => !value), []);
  return (
    <View style={containerStyle}>
      <Text>Native retained status rings</Text>
      <Button title={first ? "Hide first" : "Show first"} onPress={toggleFirst} />
      <Button title={second ? "Hide second" : "Show second"} onPress={toggleSecond} />
      <RetainedPanel active={first}>
        <Probe name="first" />
      </RetainedPanel>
      <RetainedPanel active={second}>
        <Probe name="second" />
      </RetainedPanel>
    </View>
  );
}
