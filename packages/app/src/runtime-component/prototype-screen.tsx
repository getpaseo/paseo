import { Component, type ComponentType, type ReactNode, useCallback, useReducer } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { evaluateRuntimeComponent } from "@/runtime-component/evaluate";

const INITIAL_SOURCE = `import React, { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

interface Todo {
  id: number;
  label: string;
}

export default function UserAuthoredCard() {
  const [count, setCount] = useState(0);
  const [name, setName] = useState("Ada");
  const todos: Todo[] = [
    { id: 1, label: "Compiled TSX on-device" },
    { id: 2, label: "Rendered native views" },
    { id: 3, label: "Hooks and events survived" },
  ];

  return (
    <View style={{ gap: 14, padding: 18, borderRadius: 18, backgroundColor: "#172554" }}>
      <Text style={{ color: "#93c5fd", fontSize: 12, fontWeight: "700" }}>
        USER-AUTHORED TSX STRING
      </Text>
      <Text style={{ color: "white", fontSize: 24, fontWeight: "800" }}>
        Hello {name || "stranger"}
      </Text>
      <TextInput
        accessibilityLabel="Authored name"
        value={name}
        onChangeText={setName}
        style={{ backgroundColor: "white", borderRadius: 10, padding: 12, color: "#111827" }}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={\`Native presses: \${count}\`}
        onPress={() => setCount((value) => value + 1)}
        style={{ backgroundColor: "#22c55e", borderRadius: 10, padding: 14 }}
      >
        <Text style={{ color: "#052e16", fontWeight: "800", textAlign: "center" }}>
          Native presses: {count}
        </Text>
      </Pressable>
      <View style={{ gap: 6 }}>
        {todos.map((todo) => (
          <Text key={todo.id} style={{ color: "#dbeafe" }}>✓ {todo.label}</Text>
        ))}
      </View>
    </View>
  );
}`;

const SECOND_SOURCE = `import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";

export default function SecondProgram() {
  const [isOn, setIsOn] = useState(false);
  return (
    <View style={{ gap: 16, padding: 24, borderRadius: 20, backgroundColor: "#4c1d95" }}>
      <Text style={{ color: "white", fontSize: 26, fontWeight: "900" }}>SECOND PROGRAM</Text>
      <Text style={{ color: "#ddd6fe" }}>This TSX replaced the original string at runtime.</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={isOn ? "Dynamic state on" : "Dynamic state off"}
        onPress={() => setIsOn((value) => !value)}
        style={{ padding: 16, borderRadius: 12, backgroundColor: isOn ? "#4ade80" : "#f472b6" }}
      >
        <Text style={{ textAlign: "center", fontWeight: "900" }}>{isOn ? "ON" : "OFF"}</Text>
      </Pressable>
    </View>
  );
}`;

interface SuccessfulOutput {
  kind: "success";
  Component: ComponentType;
}

interface FailedOutput {
  kind: "failure";
  message: string;
}

type PrototypeOutput = SuccessfulOutput | FailedOutput;

interface PrototypeState {
  source: string;
  revision: number;
  output: PrototypeOutput;
}

type PrototypeAction = { type: "edit"; source: string } | { type: "run"; output: PrototypeOutput };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compile(source: string): PrototypeOutput {
  try {
    return { kind: "success", Component: evaluateRuntimeComponent(source) };
  } catch (error) {
    return { kind: "failure", message: describeError(error) };
  }
}

function createInitialState(): PrototypeState {
  return {
    source: INITIAL_SOURCE,
    revision: 0,
    output: compile(INITIAL_SOURCE),
  };
}

function prototypeReducer(state: PrototypeState, action: PrototypeAction): PrototypeState {
  if (action.type === "edit") {
    return { ...state, source: action.source };
  }
  return {
    ...state,
    revision: state.revision + 1,
    output: action.output,
  };
}

interface RenderBoundaryProps {
  children: ReactNode;
}

interface RenderBoundaryState {
  message: string | null;
}

class RenderBoundary extends Component<RenderBoundaryProps, RenderBoundaryState> {
  state: RenderBoundaryState = { message: null };

  static getDerivedStateFromError(error: unknown): RenderBoundaryState {
    return { message: describeError(error) };
  }

  render() {
    if (this.state.message !== null) {
      return <Text style={styles.errorText}>Render failed: {this.state.message}</Text>;
    }
    return this.props.children;
  }
}

export function RuntimeComponentPrototypeScreen() {
  const [state, dispatch] = useReducer(prototypeReducer, undefined, createInitialState);

  const runSource = useCallback(() => {
    dispatch({ type: "run", output: compile(state.source) });
  }, [state.source]);

  const editSource = useCallback((source: string) => {
    dispatch({ type: "edit", source });
  }, []);

  const loadSecondSource = useCallback(() => {
    dispatch({ type: "edit", source: SECOND_SOURCE });
  }, []);

  const output = state.output;
  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.keyboardAvoidingView}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>Native runtime component</Text>
          <Text style={styles.subtitle}>
            Babel compiles this string locally. Hermes executes it in Paseo&apos;s JavaScript realm.
          </Text>

          <View style={styles.preview}>
            {output.kind === "success" ? (
              <RenderBoundary key={state.revision}>
                <output.Component />
              </RenderBoundary>
            ) : (
              <Text style={styles.errorText}>Compile failed: {output.message}</Text>
            )}
          </View>

          <View style={styles.editorHeader}>
            <Text style={styles.editorLabel}>user-component.tsx</Text>
            <View style={styles.editorActions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Load second authored component"
                onPress={loadSecondSource}
                style={styles.loadButton}
              >
                <Text style={styles.loadButtonText}>Load second</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Run authored component"
                onPress={runSource}
                style={styles.runButton}
              >
                <Text style={styles.runButtonText}>Run string</Text>
              </Pressable>
            </View>
          </View>
          <TextInput
            accessibilityLabel="Authored component source"
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            onChangeText={editSource}
            style={styles.editor}
            textAlignVertical="top"
            value={state.source}
          />

          <Text style={styles.warning}>
            This is code execution, not a sandbox. The string has the same authority as the app.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#020617" },
  keyboardAvoidingView: { flex: 1 },
  content: { gap: 14, padding: 18, paddingBottom: 50 },
  title: { color: "white", fontSize: 28, fontWeight: "800" },
  subtitle: { color: "#94a3b8", fontSize: 14, lineHeight: 20 },
  preview: {
    minHeight: 260,
    borderColor: "#334155",
    borderRadius: 20,
    borderWidth: 1,
    justifyContent: "center",
    padding: 12,
  },
  editorHeader: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  editorActions: { flexDirection: "row", gap: 8 },
  editorLabel: { color: "#cbd5e1", fontFamily: "Menlo", fontSize: 13 },
  loadButton: {
    backgroundColor: "#334155",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  loadButtonText: { color: "#f8fafc", fontWeight: "800" },
  runButton: {
    backgroundColor: "#f8fafc",
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  runButtonText: { color: "#0f172a", fontWeight: "800" },
  editor: {
    minHeight: 520,
    backgroundColor: "#0f172a",
    borderColor: "#334155",
    borderRadius: 12,
    borderWidth: 1,
    color: "#e2e8f0",
    fontFamily: "Menlo",
    fontSize: 11,
    lineHeight: 16,
    padding: 12,
  },
  errorText: { color: "#fca5a5", fontSize: 14, lineHeight: 20 },
  warning: { color: "#fbbf24", fontSize: 12, lineHeight: 18 },
});
