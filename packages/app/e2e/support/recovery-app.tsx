// Test-only entry: the production recovery boundary and Expo router with failing routes.
import "../../src/styles/unistyles";
// oxlint-disable-next-line import/no-unassigned-import -- Match the Metro web entry runtime.
import "@expo/metro-runtime";
import { registerRootComponent } from "expo";
import { Link, Redirect, Stack, type Href } from "expo-router";
import { useCallback, useState, type ComponentProps } from "react";
import { Button, Text, View } from "react-native";
import { RootRouter } from "../../src/root-app";

const screenOptions = { headerShown: false };
function Layout() {
  return <Stack screenOptions={screenOptions} />;
}
// Fixture routes are absent from Expo's generated production route types.
function Startup() {
  return <Redirect href={"/broken" as Href} />;
}
function BrokenWorkspace(): never {
  throw new Error("Workspace recovery fixture");
}
function Picker() {
  return (
    <View>
      <Text>Project picker</Text>
      <Link href={"/healthy" as Href}>Open healthy workspace</Link>
    </View>
  );
}
function HealthyWorkspace() {
  const [broken, setBroken] = useState(false);
  const breakWorkspace = useCallback(() => setBroken(true), []);
  if (broken) return <BrokenWorkspace />;
  return (
    <View>
      <Text>Healthy workspace</Text>
      <Button title="Break this workspace" onPress={breakWorkspace} />
    </View>
  );
}
const screens = {
  "./_layout.tsx": { default: Layout },
  "./index.tsx": { default: Startup },
  "./broken.tsx": { default: BrokenWorkspace },
  "./open-project.tsx": { default: Picker },
  "./healthy.tsx": { default: HealthyWorkspace },
};
const context: ComponentProps<typeof RootRouter>["context"] = Object.assign(
  (key: string) => screens[key as keyof typeof screens],
  { keys: () => Object.keys(screens), resolve: (key: string) => key, id: "recovery-fixture" },
);
function RecoveryApp() {
  return <RootRouter context={context} />;
}
registerRootComponent(RecoveryApp);
