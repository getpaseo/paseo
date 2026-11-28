/* oxlint-disable react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop -- Minimal markdown native regression scene. */
import React, { useCallback, useState } from "react";
import { AppRegistry, Pressable, ScrollView, Text, View } from "react-native";
import { EnrichedMarkdownText } from "react-native-enriched-markdown";

const BASE_MARKDOWN = `# Phase 1 Markdown Heading

## Subheading with \`inline_code\`

This paragraph has **bold**, *italic*, ~~struck~~, and a [docs link](https://example.com/guide).

- Unordered item one
- Unordered item two

1. First ordered item
2. Second ordered item

\`\`\`ts
const answer: number = 42;
function greet(name: string): string {
  return \`Hello, \${name}\`;
}
\`\`\`

| Component | Status |
| --- | --- |
| Parser | Ready |
| Highlighter | Green |`;

const STREAM_APPEND = `

### Streamed Section

Appended live paragraph with **streamed bold** and [new link](https://example.com/streamed).`;

const MARKDOWN_STYLE = {
  paragraph: {
    fontSize: 15,
    lineHeight: 22,
    color: "#111827",
    marginBottom: 10,
  },
  h1: {
    fontSize: 24,
    lineHeight: 30,
    fontWeight: "700",
    color: "#0f172a",
    marginBottom: 8,
  },
  h2: {
    fontSize: 19,
    lineHeight: 26,
    fontWeight: "600",
    color: "#1e293b",
    marginTop: 8,
    marginBottom: 6,
  },
  h3: {
    fontSize: 16,
    lineHeight: 22,
    fontWeight: "600",
    color: "#1e293b",
    marginTop: 6,
    marginBottom: 4,
  },
  strong: { fontWeight: "700" },
  em: { fontStyle: "italic" },
  strikethrough: { textDecorationLine: "line-through", color: "#64748b" },
  code: {
    fontFamily: "monospace",
    color: "#0f172a",
    backgroundColor: "#e2e8f0",
  },
  link: {
    color: "#2563eb",
    underline: true,
  },
  list: {
    fontSize: 15,
    lineHeight: 22,
    color: "#111827",
    bulletColor: "#475569",
    markerColor: "#475569",
    bulletSize: 6,
    gapWidth: 8,
    marginLeft: 16,
    marginBottom: 10,
  },
  codeBlock: {
    fontFamily: "monospace",
    fontSize: 13,
    lineHeight: 19,
    color: "#e2e8f0",
    backgroundColor: "#0f172a",
    borderColor: "#334155",
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
    syntaxColors: {
      keyword: "#c084fc",
      string: "#86efac",
      comment: "#94a3b8",
      number: "#fbbf24",
      type: "#38bdf8",
      function: "#60a5fa",
      operator: "#f472b6",
      punctuation: "#cbd5e1",
    },
  },
  table: {
    fontSize: 14,
    lineHeight: 20,
    color: "#111827",
    headerFontWeight: "700",
    headerBackgroundColor: "#f1f5f9",
    headerTextColor: "#0f172a",
    rowEvenBackgroundColor: "#ffffff",
    rowOddBackgroundColor: "#f8fafc",
    borderColor: "#cbd5e1",
    borderWidth: 1,
    borderRadius: 6,
    cellPaddingHorizontal: 10,
    cellPaddingVertical: 6,
    marginBottom: 10,
  },
};

function MarkdownRegression() {
  const [streamed, setStreamed] = useState(false);
  const [pressedLink, setPressedLink] = useState("none");
  const [layoutText, setLayoutText] = useState("{}");

  const handleLinkPress = useCallback((event) => {
    setPressedLink(event?.url ?? "missing");
  }, []);

  const handleLayout = useCallback((event) => {
    const layout = event?.nativeEvent?.layout;
    if (layout) setLayoutText(JSON.stringify(layout));
  }, []);

  const markdown = streamed ? `${BASE_MARKDOWN}${STREAM_APPEND}` : BASE_MARKDOWN;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: "#ffffff" }}>
      <View style={{ width: 620, padding: 16, gap: 10, backgroundColor: "#ffffff" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <EnrichedMarkdownText
            testID="markdown-link-target"
            flavor="github"
            markdown="[Open documentation](https://example.com/docs)"
            markdownStyle={MARKDOWN_STYLE}
            onLinkPress={handleLinkPress}
            allowTrailingMargin={false}
            style={{ alignSelf: "flex-start" }}
          />
          <Pressable
            testID="markdown-stream-next"
            onPress={() => setStreamed(true)}
            style={{
              width: 120,
              height: 28,
              backgroundColor: "#e2e8f0",
              justifyContent: "center",
              alignItems: "center",
            }}
          >
            <Text>Stream Next</Text>
          </Pressable>
          <Text testID="pressed-link">{pressedLink}</Text>
        </View>
        <Text testID="markdown-layout">{layoutText}</Text>
        <EnrichedMarkdownText
          testID="markdown-view"
          flavor="github"
          markdown={markdown}
          md4cFlags={{ underline: true, latexMath: true }}
          markdownStyle={MARKDOWN_STYLE}
          onLinkPress={handleLinkPress}
          onLayout={handleLayout}
          allowTrailingMargin={false}
        />
      </View>
    </ScrollView>
  );
}

AppRegistry.registerComponent("Paseo", () => MarkdownRegression);
