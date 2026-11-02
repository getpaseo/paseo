import React from "react";
import { Text, View } from "react-native";
import { HighlightedCodeBlock } from "../../src/components/highlighted-code-block";
export function MermaidFenceHost(props) {
  return (
    <View>
      <Text style={props.inheritedStyles}>
        Diagram rendering is not available in the GPUI build yet.
      </Text>
      <HighlightedCodeBlock {...props} language="mermaid" />
    </View>
  );
}
