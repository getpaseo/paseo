import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  Modal,
  ScrollView,
  FlatList,
  TextInput,
  copyText,
  useToast,
} from "@getpaseo/plugin/client/react-native";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  Pressable,
  Text,
  View,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
  type TextStyle,
  type FlatList as NativeFlatList,
} from "react-native";

const modes = [
  "Form",
  "Custom inset",
  "Full bleed",
  "ScrollView",
  "FlatList",
  "Horizontal",
] as const;
type Mode = (typeof modes)[number];
const rows = Array.from({ length: 100 }, (_, index) => index + 1);
const tabs = ["Overview", "Configuration", "Activity", "Permissions", "System logs"];
const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, gap: 12 },
  button: { padding: 12, borderWidth: 1, borderRadius: 6 },
  fill: { flex: 1, minHeight: 0 },
  customInset: { padding: 8, paddingBottom: 40, gap: 16 },
  fullBleed: { padding: 0, gap: 0 },
  row: { height: 56, padding: 16, borderBottomWidth: 1 },
  form: { gap: 16 },
  input: { borderWidth: 1, padding: 12, borderRadius: 6 },
  tabs: { flexGrow: 0, flexShrink: 0 },
  tab: { padding: 18, minWidth: 160 },
});

export function ModalExamples({ theme }: Pick<PluginSurfaceProps, "theme">) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [input, setInput] = useState("");
  const [selected, setSelected] = useState("");
  const list = useRef<NativeFlatList<number>>(null);
  const toast = useToast();
  const color = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  const body = useMemo(() => ({ backgroundColor: theme.colors.surface2 }), [theme]);
  const button = useMemo(() => [styles.button, { borderColor: theme.colors.border }], [theme]);
  const rowStyle = useMemo(() => [styles.row, { borderColor: theme.colors.border }], [theme]);
  const inputStyle = useMemo(
    () => [styles.input, color, { borderColor: theme.colors.border }],
    [color, theme],
  );

  const copy = useCallback(async () => {
    try {
      await copyText("Copied from Paseo");
      toast.show("Text copied", { variant: "success" });
    } catch {
      toast.error("Could not copy text. Select the text and use Copy.");
    }
  }, [toast]);

  const row = useCallback(
    (item: number) => {
      return (
        <ChoiceButton
          key={item}
          value={`Row ${item}`}
          label={`Row ${item}`}
          style={rowStyle}
          textStyle={color}
          onSelect={setSelected}
        />
      );
    },
    [rowStyle, color],
  );
  const renderRow = useCallback(({ item }: { item: number }) => row(item), [row]);
  const close = useCallback((open: boolean) => {
    if (!open) setMode(null);
  }, []);
  const jumpToEnd = useCallback(() => list.current?.scrollToEnd({ animated: false }), []);
  const screen = useMemo(() => [styles.screen, body], [body]);

  let contentStyle: StyleProp<ViewStyle> = styles.fullBleed;
  if (mode === "Form") contentStyle = undefined;
  if (mode === "Custom inset") contentStyle = styles.customInset;

  const form = (
    <View style={styles.form} testID="modal-example-form">
      <Text selectable style={color}>
        Paseo clipboard example
      </Text>
      <Pressable accessibilityRole="button" style={button} onPress={copy}>
        <Text style={color}>Copy text</Text>
      </Pressable>
      <TextInput
        accessibilityLabel="Paste here"
        placeholder="Paste here"
        placeholderTextColor={theme.colors.foregroundMuted}
        style={inputStyle}
        value={input}
        onChangeText={setInput}
      />
      <Text style={color}>Input: {input || "empty"}</Text>
    </View>
  );

  return (
    <View style={screen}>
      <Text style={color}>Modal body examples</Text>
      {modes.map((example) => (
        <ChoiceButton<Mode>
          key={example}
          value={example}
          label={`Open ${example}`}
          style={button}
          textStyle={color}
          onSelect={setMode}
        />
      ))}
      <Text style={color}>Selected: {selected || "none"}</Text>
      <Modal title={`Modal example: ${mode ?? "Form"}`} open={mode !== null} onOpenChange={close}>
        <Modal.Content
          style={body}
          contentContainerStyle={contentStyle}
          scrollable={mode !== "ScrollView" && mode !== "FlatList"}
        >
          {mode === "Form" || mode === "Custom inset" ? form : null}
          {mode === "Full bleed" ? rows.map(row) : null}
          {mode === "ScrollView" ? (
            <ScrollView style={styles.fill} keyboardShouldPersistTaps="handled">
              {rows.map(row)}
            </ScrollView>
          ) : null}
          {mode === "FlatList" ? (
            <>
              <Pressable accessibilityRole="button" style={button} onPress={jumpToEnd}>
                <Text style={color}>Jump to last row</Text>
              </Pressable>
              <FlatList
                ref={list}
                style={styles.fill}
                data={rows}
                keyExtractor={String}
                renderItem={renderRow}
                getItemLayout={getRowLayout}
              />
            </>
          ) : null}
          {mode === "Horizontal" ? (
            <>
              <ScrollView horizontal style={styles.tabs}>
                {tabs.map((tab) => (
                  <ChoiceButton
                    key={tab}
                    value={tab}
                    label={tab}
                    style={styles.tab}
                    textStyle={color}
                    onSelect={setSelected}
                  />
                ))}
              </ScrollView>
              {form}
              {rows.slice(0, 20).map(row)}
            </>
          ) : null}
        </Modal.Content>
      </Modal>
    </View>
  );
}

function getRowLayout(_: unknown, index: number) {
  return { index, length: 56, offset: index * 56 };
}

function ChoiceButton<Value extends string>({
  value,
  label,
  style,
  textStyle,
  onSelect,
}: {
  value: Value;
  label: string;
  style: StyleProp<ViewStyle>;
  textStyle: StyleProp<TextStyle>;
  onSelect(value: Value): void;
}) {
  const select = useCallback(() => onSelect(value), [onSelect, value]);
  return (
    <Pressable accessibilityRole="button" style={style} onPress={select}>
      <Text style={textStyle}>{label}</Text>
    </Pressable>
  );
}
