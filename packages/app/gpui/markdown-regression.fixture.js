/* oxlint-disable react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop -- Minimal markdown native regression scene. */
import React, { useCallback, useState } from "react";
import { AppRegistry, Pressable, Text, View } from "react-native";
import { EnrichedMarkdownText } from "react-native-enriched-markdown";

const BASE_MARKDOWN = `# Phase 1 Heading

## Subhead \`code\`

**bold**, *italic*, ~~struck~~, [docs](https://example.com/guide).

> Blockquote note

- Bullet one
- Bullet two

1. Ordered one
2. Ordered two

- [x] Done task
- [ ] Open task

\`\`\`ts
const n: number = 42;
function hi(s: string): string {
  return \`Hi \${s}\`;
}
\`\`\`

| Component | Status |
| --- | --- |
| Parser | Ready |`;

const STREAM_APPEND = `

### Streamed

Appended **live** and [next](https://example.com/streamed).`;

const MARKDOWN_STYLE = {
  paragraph: {
    fontSize: 13,
    lineHeight: 17,
    color: "#111827",
    marginBottom: 4,
  },
  h1: {
    fontSize: 19,
    lineHeight: 23,
    fontWeight: "700",
    color: "#0f172a",
    marginBottom: 4,
  },
  h2: {
    fontSize: 16,
    lineHeight: 20,
    fontWeight: "600",
    color: "#1e293b",
    marginTop: 2,
    marginBottom: 4,
  },
  h3: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: "600",
    color: "#1e293b",
    marginTop: 2,
    marginBottom: 2,
  },
  h5: {
    fontSize: 13,
    lineHeight: 17,
    fontWeight: "600",
    color: "#334155",
    marginBottom: 2,
  },
  strong: { fontWeight: "700" },
  em: { fontStyle: "italic" },
  strikethrough: { textDecorationLine: "line-through", color: "#64748b" },
  code: {
    fontFamily: "monospace",
    fontScale: 0.85,
    color: "#0f172a",
    backgroundColor: "#e2e8f0",
  },
  link: {
    color: "#2563eb",
    underline: true,
  },
  list: {
    fontSize: 13,
    lineHeight: 17,
    color: "#111827",
    bulletColor: "#475569",
    markerColor: "#475569",
    bulletSize: 5,
    gapWidth: 6,
    marginLeft: 14,
    itemSpacing: 1,
    marginBottom: 4,
  },
  taskList: {
    checkedColor: "#2563eb",
    borderColor: "#475569",
    checkmarkColor: "#ffffff",
    checkedTextColor: "#64748b",
    checkedStrikethrough: true,
    checkboxSize: 13,
  },
  blockquote: {
    fontSize: 13,
    lineHeight: 17,
    color: "#1e293b",
    backgroundColor: "#eff6ff",
    borderColor: "#2563eb",
    borderWidth: 4,
    padding: 6,
    gapWidth: 6,
    marginBottom: 4,
  },
  codeBlock: {
    fontFamily: "monospace",
    fontSize: 11,
    lineHeight: 15,
    color: "#e2e8f0",
    backgroundColor: "#0f172a",
    borderColor: "#334155",
    borderWidth: 1,
    borderRadius: 6,
    padding: 6,
    marginBottom: 4,
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
    fontSize: 12,
    lineHeight: 16,
    color: "#111827",
    headerFontWeight: "700",
    headerBackgroundColor: "#dbeafe",
    headerTextColor: "#0f172a",
    rowEvenBackgroundColor: "#ffffff",
    rowOddBackgroundColor: "#f8fafc",
    borderColor: "#2563eb",
    borderWidth: 1,
    borderRadius: 5,
    cellPaddingHorizontal: 6,
    cellPaddingVertical: 3,
    marginBottom: 4,
  },
};

function MarkdownRegression() {
  const [streamed, setStreamed] = useState(false);
  const [pressedLink, setPressedLink] = useState("none");
  const [taskEvent, setTaskEvent] = useState("none");
  const [codeEvent, setCodeEvent] = useState("none");
  const [layoutText, setLayoutText] = useState("{}");

  const handleLinkPress = useCallback((event) => {
    setPressedLink(event?.url ?? "missing");
  }, []);

  const handleTaskPress = useCallback((event) => {
    setTaskEvent(`${event?.index}:${event?.checked}:${event?.text}`);
  }, []);

  const handleCodePress = useCallback((event) => {
    setCodeEvent(`${event?.language}:${String(event?.code ?? "").trim().length}`);
  }, []);

  const handleLayout = useCallback((event) => {
    const layout = event?.nativeEvent?.layout;
    if (layout) setLayoutText(JSON.stringify(layout));
  }, []);

  const markdown = streamed ? `${BASE_MARKDOWN}${STREAM_APPEND}` : BASE_MARKDOWN;

  return (
    <View
      style={{ flex: 1, flexDirection: "row", padding: 8, gap: 10, backgroundColor: "#ffffff" }}
    >
      <View style={{ width: 320, gap: 4, backgroundColor: "#ffffff" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <EnrichedMarkdownText
            testID="markdown-link-target"
            flavor="github"
            markdown="[Open docs](https://example.com/docs)"
            markdownStyle={MARKDOWN_STYLE}
            onLinkPress={handleLinkPress}
            allowTrailingMargin={false}
            style={{ alignSelf: "flex-start" }}
          />
          <Pressable
            testID="markdown-stream-next"
            onPress={() => setStreamed(true)}
            style={{
              width: 82,
              height: 20,
              backgroundColor: "#e2e8f0",
              justifyContent: "center",
              alignItems: "center",
            }}
          >
            <Text style={{ fontSize: 12 }}>Stream Next</Text>
          </Pressable>
          <Text testID="pressed-link" style={{ fontSize: 11 }}>
            {pressedLink}
          </Text>
          <Text testID="task-event" style={{ fontSize: 11 }}>
            {taskEvent}
          </Text>
          <Text testID="code-event" style={{ fontSize: 11 }}>
            {codeEvent}
          </Text>
        </View>
        <Text testID="markdown-layout" style={{ fontSize: 10 }}>
          {layoutText}
        </Text>
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

      <View style={{ width: 320, gap: 3, backgroundColor: "#ffffff" }}>
        <View style={{ flexDirection: "row", gap: 6, backgroundColor: "#ffffff" }}>
          <View testID="probe-text-plain" style={{ backgroundColor: "#ffffff" }}>
            <Text style={{ fontSize: 13, color: "#111827" }}>Sample</Text>
          </View>
          <View testID="probe-text-bold" style={{ backgroundColor: "#ffffff" }}>
            <Text style={{ fontSize: 13, fontWeight: "700", color: "#111827" }}>Sample</Text>
          </View>
          <View testID="probe-text-italic" style={{ backgroundColor: "#ffffff" }}>
            <Text style={{ fontSize: 13, fontStyle: "italic", color: "#111827" }}>Sample</Text>
          </View>
        </View>

        <View style={{ flexDirection: "row", gap: 6, alignItems: "flex-start" }}>
          <View testID="block-h1" style={{ width: 155, backgroundColor: "#ffffff" }}>
            <EnrichedMarkdownText
              testID="block-h1-md"
              flavor="github"
              markdown="# Heading A"
              markdownStyle={MARKDOWN_STYLE}
              allowTrailingMargin={false}
            />
          </View>
          <View testID="block-h5" style={{ width: 155, backgroundColor: "#ffffff" }}>
            <EnrichedMarkdownText
              testID="block-h5-md"
              flavor="github"
              markdown="##### Heading A"
              markdownStyle={MARKDOWN_STYLE}
              allowTrailingMargin={false}
            />
          </View>
        </View>

        <View style={{ flexDirection: "row", gap: 6 }}>
          <View testID="block-emphasis-plain" style={{ width: 155, backgroundColor: "#ffffff" }}>
            <EnrichedMarkdownText
              flavor="github"
              markdown="alpha beta gamma"
              markdownStyle={MARKDOWN_STYLE}
              allowTrailingMargin={false}
            />
          </View>
          <View testID="block-emphasis-styled" style={{ width: 155, backgroundColor: "#ffffff" }}>
            <EnrichedMarkdownText
              flavor="github"
              markdown="**alpha** *beta* ~~gamma~~"
              markdownStyle={MARKDOWN_STYLE}
              allowTrailingMargin={false}
            />
          </View>
        </View>

        <View style={{ flexDirection: "row", gap: 6 }}>
          <View testID="block-inline-code-plain" style={{ width: 155, backgroundColor: "#ffffff" }}>
            <EnrichedMarkdownText
              flavor="github"
              markdown="use code_val"
              markdownStyle={MARKDOWN_STYLE}
              allowTrailingMargin={false}
            />
          </View>
          <View testID="block-inline-code" style={{ width: 155, backgroundColor: "#ffffff" }}>
            <EnrichedMarkdownText
              flavor="github"
              markdown={"use `code_val`"}
              markdownStyle={MARKDOWN_STYLE}
              allowTrailingMargin={false}
            />
          </View>
        </View>

        <View style={{ flexDirection: "row", gap: 6 }}>
          <View testID="block-ul" style={{ width: 100, backgroundColor: "#ffffff" }}>
            <EnrichedMarkdownText
              flavor="github"
              markdown={"- One\n- Two"}
              markdownStyle={MARKDOWN_STYLE}
              allowTrailingMargin={false}
            />
          </View>
          <View testID="block-ol-1" style={{ width: 100, backgroundColor: "#ffffff" }}>
            <EnrichedMarkdownText
              flavor="github"
              markdown={"1. One\n2. Two"}
              markdownStyle={MARKDOWN_STYLE}
              allowTrailingMargin={false}
            />
          </View>
          <View testID="block-ol-8" style={{ width: 100, backgroundColor: "#ffffff" }}>
            <EnrichedMarkdownText
              flavor="github"
              markdown={"8. One\n9. Two"}
              markdownStyle={MARKDOWN_STYLE}
              allowTrailingMargin={false}
            />
          </View>
        </View>

        <View style={{ flexDirection: "row", gap: 6 }}>
          <View testID="block-task-checked" style={{ width: 132, backgroundColor: "#ffffff" }}>
            <EnrichedMarkdownText
              flavor="github"
              markdown="- [x] Done task"
              markdownStyle={MARKDOWN_STYLE}
              allowTrailingMargin={false}
            />
          </View>
          <View testID="block-task-unchecked" style={{ width: 132, backgroundColor: "#ffffff" }}>
            <EnrichedMarkdownText
              flavor="github"
              markdown="- [ ] Open task"
              markdownStyle={MARKDOWN_STYLE}
              allowTrailingMargin={false}
            />
          </View>
          <EnrichedMarkdownText
            testID="block-task-toggle-md"
            flavor="github"
            markdown="- [ ] Ok"
            markdownStyle={MARKDOWN_STYLE}
            enableTaskListItemToggle={true}
            onTaskListItemPress={handleTaskPress}
            allowTrailingMargin={false}
            style={{ width: 44, height: 17 }}
          />
        </View>

        <View testID="block-blockquote" style={{ width: 320, backgroundColor: "#ffffff" }}>
          <EnrichedMarkdownText
            flavor="github"
            markdown="> Quoted note"
            markdownStyle={MARKDOWN_STYLE}
            allowTrailingMargin={false}
          />
        </View>

        <View testID="block-code" style={{ width: 320, backgroundColor: "#ffffff" }}>
          <EnrichedMarkdownText
            testID="block-code-md"
            flavor="github"
            markdown={"```ts\nconst n: number = 42;\n```"}
            markdownStyle={MARKDOWN_STYLE}
            onCodeBlockPress={handleCodePress}
            allowTrailingMargin={false}
          />
        </View>

        <View testID="block-table" style={{ width: 320, backgroundColor: "#ffffff" }}>
          <EnrichedMarkdownText
            flavor="github"
            markdown={"| ColA | ColB |\n| --- | --- |\n| Left | Right |"}
            markdownStyle={MARKDOWN_STYLE}
            allowTrailingMargin={false}
          />
        </View>
      </View>
    </View>
  );
}

AppRegistry.registerComponent("Paseo", () => MarkdownRegression);
