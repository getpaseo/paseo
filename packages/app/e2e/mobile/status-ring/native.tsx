import { useCallback, useLayoutEffect, useState } from "react";
import { Button, Text, View } from "react-native";
import { RetainedPanel } from "@/components/retained-panel";
import { useStatusRingProgress } from "@/components/status-ring/clock";
import { StatusRing } from "@/components/status-ring";

interface Sample {
  updates: number;
  rotation: number;
}

declare global {
  var __ringSamples: Record<string, Sample>;
  var __ringReaders: Record<string, () => void>;
}

function Probe({ name }: { name: string }) {
  const progress = useStatusRingProgress();
  // The native driver only reports values to JS while a listener is attached, which is what
  // lets this probe count updates; production rings attach none.
  useLayoutEffect(() => {
    globalThis.__ringSamples ??= {};
    globalThis.__ringReaders ??= {};
    const sample: Sample = { updates: 0, rotation: 0 };
    const id = progress.addListener(({ value }) => {
      sample.updates += 1;
      sample.rotation = (value % 1) * 360;
    });
    globalThis.__ringReaders[name] = () => {
      globalThis.__ringSamples[name] = { ...sample };
    };
    return () => {
      progress.removeListener(id);
      delete globalThis.__ringReaders[name];
    };
  }, [name, progress]);
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
