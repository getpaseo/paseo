/* oxlint-disable react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop -- Minimal native regression scene. */
import React, { useCallback, useState } from "react";
import { AppRegistry, Image, Pressable, ScrollView, Text, TextInput, View } from "react-native";

function AppearanceRegression() {
  const [buttonHovered, setHovered] = useState(false);
  const [entered, setEntered] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [layouts, setLayouts] = useState({});

  const record = useCallback((key, event) => {
    const layout = event?.nativeEvent?.layout;
    const layoutKeys = layout ? Object.keys(layout).sort() : [];
    setLayouts((prev) => ({
      ...prev,
      [key]: {
        count: (prev[key]?.count ?? 0) + 1,
        keys: layoutKeys,
        layout,
      },
    }));
  }, []);

  const onViewLayout = useCallback((e) => record("view", e), [record]);
  const onTextLayout = useCallback((e) => record("text", e), [record]);
  const onInputLayout = useCallback((e) => record("textInput", e), [record]);
  const onImageLayout = useCallback((e) => record("image", e), [record]);
  const onScrollLayout = useCallback((e) => record("scrollView", e), [record]);

  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: "white", padding: 40, gap: 40 }}>
      <View style={{ gap: 24 }}>
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

      <View style={{ gap: 12, alignItems: "flex-start" }}>
        <Pressable
          testID="layout-resize-toggle"
          onPress={() => setExpanded((value) => !value)}
          style={{ width: 160, height: 32, backgroundColor: "#dddddd", justifyContent: "center" }}
        >
          <Text>{expanded ? "Shrink" : "Expand"}</Text>
        </Pressable>
        <View
          testID="layout-view"
          onLayout={onViewLayout}
          style={{ width: expanded ? 180 : 120, height: 24, backgroundColor: "#eeeeee" }}
        />
        <Text testID="layout-text" onLayout={onTextLayout}>
          {expanded ? "Measure a much longer text label" : "Short label"}
        </Text>
        <TextInput
          testID="layout-text-input"
          onLayout={onInputLayout}
          defaultValue="hi"
          style={{ width: expanded ? 200 : 140, height: 32, borderWidth: 1 }}
        />
        <Image
          testID="layout-image"
          onLayout={onImageLayout}
          style={{ width: expanded ? 96 : 64, height: 32, backgroundColor: "#cccccc" }}
        />
        <ScrollView
          testID="layout-scroll"
          onLayout={onScrollLayout}
          style={{
            flexGrow: 0,
            flexShrink: 0,
            width: expanded ? 210 : 150,
            height: 40,
            backgroundColor: "#eeeeee",
          }}
        >
          <View style={{ width: expanded ? 210 : 150, height: 80 }} />
        </ScrollView>
        <Text testID="layout-results">{JSON.stringify(layouts)}</Text>
      </View>
    </View>
  );
}

AppRegistry.registerComponent("Paseo", () => AppearanceRegression);
