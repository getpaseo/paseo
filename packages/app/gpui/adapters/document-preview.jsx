import React from "react";
import { ScrollView, Text, View } from "react-native";
import { HighlightedCodeBlock } from "../../src/components/highlighted-code-block";

export function FileHtmlPreview({ html, testID }) {
  return (
    <ScrollView testID={testID}>
      <Text>HTML rendering is not available in GPUI. Showing source.</Text>
      <HighlightedCodeBlock code={html} language="html" />
    </ScrollView>
  );
}
export function DocumentFrame({ testID }) {
  return (
    <View testID={testID}>
      <Text>Document preview is not available in the GPUI build yet.</Text>
    </View>
  );
}
