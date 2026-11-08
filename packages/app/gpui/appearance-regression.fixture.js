/* oxlint-disable react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop -- Minimal native regression scene. */
import React, { useState } from "react";
import { AppRegistry, Pressable, Text, View } from "react-native";

function AppearanceRegression() {
  const [buttonHovered, setHovered] = useState(false);
  const [entered, setEntered] = useState(false);
  return (
    <View style={{ flex: 1, backgroundColor: "white", padding: 40, gap: 24 }}>
      <View
        testID="rounded-border"
        style={{
          width: 200,
          height: 100,
          borderRadius: 24,
          borderWidth: 4,
          borderColor: "#ff0000",
          backgroundColor: "#0000ff",
        }}
      />
      <Pressable
        testID="hover-button"
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        style={{ width: 200, height: 60, backgroundColor: buttonHovered ? "#00ff00" : "#0000ff" }}
      >
        <Text>{buttonHovered ? "hover active" : "hover inactive"}</Text>
      </Pressable>
      <Pressable
        testID="hover-render-prop"
        style={({ hovered }) => ({
          width: 200,
          height: 60,
          backgroundColor: hovered ? "#00ff00" : "#0000ff",
        })}
      >
        {({ hovered }) => <Text>{hovered ? "render hovered" : "render idle"}</Text>}
      </Pressable>
      <View
        testID="hover-row"
        onPointerEnter={() => setEntered(true)}
        onPointerLeave={() => setEntered(false)}
        style={{ width: 200, height: 60, backgroundColor: entered ? "#00ff00" : "#0000ff" }}
      >
        <Pressable testID="nested-button" style={{ width: 100, height: 60 }}>
          <Text>{entered ? "row active" : "row inactive"}</Text>
        </Pressable>
      </View>
      <View testID="outside-hover" style={{ width: 200, height: 60 }} />
    </View>
  );
}

AppRegistry.registerComponent("Paseo", () => AppearanceRegression);
